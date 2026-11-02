# Vendored tiny_http

- Upstream: `tiny_http` **0.12.0** from crates.io (https://crates.io/crates/tiny_http,
  repository https://github.com/tiny-http/tiny-http), checksum
  `389915df6413a2e74fb181895f933386023c71110878cd0825588928e64cdc82`.
- Copied from the cargo registry source unchanged, except for the diff below. Left out:
  `.cargo-ok`, `.cargo_vcs_info.json`, `.github/`, the crate's own `Cargo.lock`, and
  `examples/` and `benches/` (cargo finds them by folder, so nothing else names them; `examples/`
  held a sample TLS key, `ssl-key.pem`).
  `LICENSE-MIT`, `LICENSE-APACHE` and `README.md` are kept.
- Used through `[patch.crates-io]` in `src-tauri/Cargo.toml`.

## Why

When a `Request` whose body is over 1024 bytes is dropped without reading the whole body,
`EqualReader::drop` drained the rest into `vec![0; remaining]`, sized by the client's
`Content-Length`. DocBro's MCP server refuses unauthenticated requests without reading their
body, so one header-only request claiming `Content-Length: 4611686018427387904` aborted the app
("memory allocation ... failed") and lost every unsaved document.

## What changed

- Draining uses a fixed 8 KiB stack buffer.
- Bodies with more than 64 KiB left unread are not drained at all, so a client that claims a
  huge body and sends nothing cannot hold the thread.
- A connection serves no more requests after one whose `Content-Length` is over that limit, or
  that is chunked (upstream never drains a chunked body). Before this, the unread bytes were read
  as the next request: a request refused without reading its body (wrong `Host`, an `Origin`)
  could carry a second one that skipped those checks. The response is sent, then the connection
  closes, as for a request that says `Connection: close`. A client that sends such a body on
  purpose (DocBro reads up to 8 MiB) only has to open a new connection for the next request.
- Draining still stops at end of stream or on a read error, as before.
- `Cargo.toml` gets a `[lints.rust]` table that allows `unused_imports` and `dead_code`. Path
  dependencies are not lint-capped like registry crates, and the two upstream warnings (an unused
  import in `util/mod.rs`, an unused test trait in `lib.rs`) would otherwise show in every build.

## Re-syncing

Copy a newer `tiny_http` over this folder, then re-apply this diff (or drop the vendored
copy and the `[patch.crates-io]` entry if upstream has fixed `EqualReader::drop` and the reuse of
a connection after an unread body). The tests `mcp::tests::a_lying_content_length_cannot_take_the_app_down`
and `mcp::tests::an_unread_body_cannot_smuggle_a_second_request` must keep passing.

```diff
--- a/src/util/equal_reader.rs
+++ b/src/util/equal_reader.rs
@@ -59,17 +59,28 @@
     }
 }
 
+/// DocBro patch: the most a dropped reader drains so the connection can serve another request.
+/// A larger unread body is left alone, since reading it would let a client that claims a huge
+/// body (and sends nothing) hold the thread. Its bytes would then be read as the next request,
+/// so `ClientConnection` serves no more requests after one whose body is this large.
+pub(crate) const DRAIN_LIMIT: usize = 64 * 1024;
+
 impl<R> Drop for EqualReader<R>
 where
     R: Read,
 {
     fn drop(&mut self) {
         let mut remaining_to_read = self.size;
+        if remaining_to_read > DRAIN_LIMIT {
+            self.last_read_signal.send(Ok(())).ok();
+            return;
+        }
+        // DocBro patch: a fixed buffer, never one sized by the client's Content-Length
+        let mut buf = [0u8; 8 * 1024];
 
         while remaining_to_read > 0 {
-            let mut buf = vec![0; remaining_to_read];
-
-            match self.reader.read(&mut buf) {
+            let len = remaining_to_read.min(buf.len());
+            match self.reader.read(&mut buf[..len]) {
                 Err(e) => {
                     self.last_read_signal.send(Err(e)).ok();
                     break;
--- a/src/util/mod.rs
+++ b/src/util/mod.rs
@@ -1,5 +1,6 @@
 pub use self::custom_stream::CustomStream;
 pub use self::equal_reader::EqualReader;
+pub(crate) use self::equal_reader::DRAIN_LIMIT;
 pub use self::fused_reader::FusedReader;
 pub use self::messages_queue::MessagesQueue;
 pub use self::refined_tcp_stream::RefinedTcpStream;
--- a/src/client.rs
+++ b/src/client.rs
@@ -258,6 +258,14 @@
                 None if *rq.http_version() == HTTPVersion(1, 0) => self.no_more_requests = true,
                 _ => (),
             };
+
+            // DocBro patch: a body that may be dropped unread is not drained (over DRAIN_LIMIT) or
+            // cannot be (chunked), and its bytes would be read as the next request, past every
+            // check the server makes. The connection ends with this request instead.
+            let chunked = rq.headers().iter().any(|h| h.field.equiv("Transfer-Encoding"));
+            if chunked || rq.body_length().is_some_and(|len| len > crate::util::DRAIN_LIMIT) {
+                self.no_more_requests = true;
+            }
 
             // returning the request
             return Some(rq);
```

```diff
--- a/Cargo.toml
+++ b/Cargo.toml
@@ -80,3 +80,9 @@
     "rustls-pemfile",
     "zeroize",
 ]
+
+# DocBro: path dependencies are not lint-capped like registry crates; keep the two upstream
+# warnings (an unused import, an unused test trait) out of DocBro's build output
+[lints.rust]
+unused_imports = "allow"
+dead_code = "allow"
```
