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
- Bodies with more than 64 KiB left unread are not drained when the request is dropped, which
  happens on DocBro's server thread: a client that claims a huge body and sends nothing cannot
  hold it. The reader signals how much it left unread instead (`last_read_signal`, which upstream
  never listened to, now carries that count; `Request::unread_body` hands it on).
- A connection serves no more requests after one whose `Content-Length` is over that limit, or
  that is chunked (upstream never drains a chunked body). Before this, the unread bytes were read
  as the next request: a request refused without reading its body (wrong `Host`, an `Origin`)
  could carry a second one that skipped those checks. The response is sent, then the connection
  closes, as for a request that says `Connection: close`. A client that sends such a body on
  purpose (DocBro reads up to 8 MiB) only has to open a new connection for the next request.
- Before it closes, the connection reads and throws away what is left of a `Content-Length` body
  (up to 16 MiB), on its own thread, like an idle keep-alive connection waits there. Closing a
  socket with unread data resets it, and the client could lose the response or fail to send.
  A chunked body is not read on: the connection closes at once.
- Draining still stops at end of stream or on a read error, as before.
- `Cargo.toml` gets a `[lints.rust]` table that allows `unused_imports` and `dead_code`. Path
  dependencies are not lint-capped like registry crates, and the two upstream warnings (an unused
  import in `util/mod.rs`, an unused test trait in `lib.rs`) would otherwise show in every build.

## Re-syncing

Copy a newer `tiny_http` over this folder, then re-apply this diff (or drop the vendored
copy and the `[patch.crates-io]` entry if upstream has fixed `EqualReader::drop` and the reuse of
a connection after an unread body). The tests `mcp::tests::a_lying_content_length_cannot_take_the_app_down`,
`mcp::tests::an_unread_body_cannot_smuggle_a_second_request` and
`mcp::tests::a_refused_body_past_the_drain_limit_is_read_to_its_end_before_the_connection_closes`
must keep passing.

```diff
--- a/src/util/equal_reader.rs
+++ b/src/util/equal_reader.rs
@@ -14,14 +14,16 @@
 {
     reader: R,
     size: usize,
-    last_read_signal: Sender<IoResult<()>>,
+    // DocBro patch: on drop, how much of the body is left for the connection to discard (0 once
+    // drained or at end of stream); nothing is sent when the body was read to its end
+    last_read_signal: Sender<IoResult<usize>>,
 }
 
 impl<R> EqualReader<R>
 where
     R: Read,
 {
-    pub fn new(reader: R, size: usize) -> (EqualReader<R>, Receiver<IoResult<()>>) {
+    pub fn new(reader: R, size: usize) -> (EqualReader<R>, Receiver<IoResult<usize>>) {
         let (tx, rx) = channel();
 
         let r = EqualReader {
@@ -59,23 +61,34 @@
     }
 }
 
+/// DocBro patch: the most a dropped reader drains so the connection can serve another request.
+/// A larger unread body is left alone: the reader is dropped on the server's own thread, which a
+/// client that claims a huge body (and sends nothing) would hold. Its size is signalled instead,
+/// and `ClientConnection`, on the connection's thread, discards it and serves no more requests.
+pub(crate) const DRAIN_LIMIT: usize = 64 * 1024;
+
 impl<R> Drop for EqualReader<R>
 where
     R: Read,
 {
     fn drop(&mut self) {
         let mut remaining_to_read = self.size;
+        if remaining_to_read > DRAIN_LIMIT {
+            self.last_read_signal.send(Ok(remaining_to_read)).ok();
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
                 }
                 Ok(0) => {
-                    self.last_read_signal.send(Ok(())).ok();
+                    self.last_read_signal.send(Ok(0)).ok();
                     break;
                 }
                 Ok(other) => {
--- a/src/util/mod.rs
+++ b/src/util/mod.rs
@@ -1,5 +1,6 @@
 pub use self::custom_stream::CustomStream;
 pub use self::equal_reader::EqualReader;
+pub(crate) use self::equal_reader::DRAIN_LIMIT;
 pub use self::fused_reader::FusedReader;
 pub use self::messages_queue::MessagesQueue;
 pub use self::refined_tcp_stream::RefinedTcpStream;
--- a/src/request.rs
+++ b/src/request.rs
@@ -5,7 +5,7 @@
 use std::net::SocketAddr;
 use std::str::FromStr;
 
-use std::sync::mpsc::Sender;
+use std::sync::mpsc::{Receiver, Sender};
 
 use crate::util::{EqualReader, FusedReader};
 use crate::{HTTPVersion, Header, Method, Response, StatusCode};
@@ -74,6 +74,10 @@
 
     // If Some, a message must be sent after responding
     notify_when_responded: Option<Sender<()>>,
+
+    // DocBro patch: how much of a body over the drain limit was left unread, once the body
+    // reader is dropped (`EqualReader`); taken by `ClientConnection`
+    pub(crate) unread_body: Option<Receiver<io::Result<usize>>>,
 }
 
 struct NotifyOnDrop<R> {
@@ -185,6 +189,7 @@
 
     // we wrap `source_data` around a reading whose nature depends on the transfer-encoding and
     // content-length headers
+    let mut unread_body = None;
     let reader = if connection_upgrade {
         // if we have a `Connection: upgrade`, always keeping the whole reader
         Box::new(source_data) as Box<dyn Read + Send + 'static>
@@ -212,7 +217,8 @@
 
             Box::new(Cursor::new(buffer)) as Box<dyn Read + Send + 'static>
         } else {
-            let (data_reader, _) = EqualReader::new(source_data, content_length); // TODO:
+            let (data_reader, unread) = EqualReader::new(source_data, content_length);
+            unread_body = Some(unread);
             Box::new(FusedReader::new(data_reader)) as Box<dyn Read + Send + 'static>
         }
     } else if transfer_encoding.is_some() {
@@ -238,6 +244,7 @@
         body_length: content_length,
         must_send_continue: expects_continue,
         notify_when_responded: None,
+        unread_body,
     })
 }
 
--- a/src/client.rs
+++ b/src/client.rs
@@ -2,7 +2,7 @@
 
 use std::io::Error as IoError;
 use std::io::Result as IoResult;
-use std::io::{BufReader, BufWriter, ErrorKind, Read};
+use std::io::{self, BufReader, BufWriter, ErrorKind, Read};
 
 use std::net::SocketAddr;
 use std::str::FromStr;
@@ -12,6 +12,10 @@
 use crate::util::{SequentialReader, SequentialReaderBuilder, SequentialWriterBuilder};
 use crate::Request;
 
+/// DocBro patch: the most of an unread body a closing connection reads and throws away. Past it the
+/// connection is closed with the rest unread.
+const LINGER_LIMIT: usize = 16 * 1024 * 1024;
+
 /// A ClientConnection is an object that will store a socket to a client
 /// and return Request objects.
 pub struct ClientConnection {
@@ -32,6 +36,9 @@
     // set to true if we know that the previous request is the last one
     no_more_requests: bool,
 
+    // DocBro patch: the last request's body, if it may be left unread past the drain limit
+    unread_body: Option<std::sync::mpsc::Receiver<IoResult<usize>>>,
+
     // true if the connection goes through SSL
     secure: bool,
 }
@@ -64,6 +71,7 @@
             remote_addr,
             next_header_source: first_header,
             no_more_requests: false,
+            unread_body: None,
             secure,
         }
     }
@@ -180,11 +188,18 @@
         // the client sent a "connection: close" header in this previous request
         //  or is using HTTP 1.0, meaning that no new request will come
         if self.no_more_requests {
+            // DocBro patch: what the request left of its body is read and thrown away here, on
+            // the connection's thread, once the request is done with. Closing with it unread
+            // would reset the connection, which can cost the client the response.
+            if let Some(Ok(Ok(left))) = self.unread_body.take().map(|rx| rx.recv()) {
+                let mut rest = self.next_header_source.by_ref().take(left.min(LINGER_LIMIT) as u64);
+                io::copy(&mut rest, &mut io::sink()).ok();
+            }
             return None;
         }
 
         loop {
-            let rq = match self.read() {
+            let mut rq = match self.read() {
                 Err(ReadError::WrongRequestLine) => {
                     let writer = self.sink.next().unwrap();
                     let response = Response::new_empty(StatusCode(400));
@@ -259,6 +274,15 @@
                 _ => (),
             };
 
+            // DocBro patch: a body that may be dropped unread is not drained (over DRAIN_LIMIT) or
+            // cannot be (chunked), and its bytes would be read as the next request, past every
+            // check the server makes. The connection ends with this request instead.
+            let chunked = rq.headers().iter().any(|h| h.field.equiv("Transfer-Encoding"));
+            if chunked || rq.body_length().is_some_and(|len| len > crate::util::DRAIN_LIMIT) {
+                self.no_more_requests = true;
+                self.unread_body = rq.unread_body.take();
+            }
+
             // returning the request
             return Some(rq);
         }
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
