use std::future::Future;
use std::pin::Pin;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, BufWriter, Lines,
};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::bus::{BusClientError, BusMessage, BusResult};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsWriter = SplitSink<WsStream, Message>;
type WsReader = SplitStream<WsStream>;

pub(crate) trait TransportWriter: Send {
    fn send<'a>(
        &'a mut self,
        message: &'a BusMessage,
    ) -> Pin<Box<dyn Future<Output = BusResult<()>> + Send + 'a>>;

    fn close<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = BusResult<()>> + Send + 'a>>;
}

pub(crate) trait TransportReader: Send {
    fn next<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = BusResult<Option<BusMessage>>> + Send + 'a>>;
}

pub(crate) type BoxTransportWriter = Box<dyn TransportWriter>;
pub(crate) type BoxTransportReader = Box<dyn TransportReader>;

pub(crate) struct WebSocketTransportWriter {
    writer: WsWriter,
}

pub(crate) struct WebSocketTransportReader {
    reader: WsReader,
}

pub(crate) async fn connect_websocket(
    url: &str,
) -> BusResult<(BoxTransportWriter, BoxTransportReader)> {
    let (stream, _) = connect_async(url).await?;
    let (writer, reader) = stream.split();
    Ok((
        Box::new(WebSocketTransportWriter { writer }),
        Box::new(WebSocketTransportReader { reader }),
    ))
}

impl TransportWriter for WebSocketTransportWriter {
    fn send<'a>(
        &'a mut self,
        message: &'a BusMessage,
    ) -> Pin<Box<dyn Future<Output = BusResult<()>> + Send + 'a>> {
        Box::pin(async move {
            let text = serde_json::to_string(message)?;
            self.writer.send(Message::Text(text.into())).await?;
            Ok(())
        })
    }

    fn close<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = BusResult<()>> + Send + 'a>> {
        Box::pin(async move { self.writer.close().await.map_err(BusClientError::from) })
    }
}

impl TransportReader for WebSocketTransportReader {
    fn next<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = BusResult<Option<BusMessage>>> + Send + 'a>> {
        Box::pin(async move {
            loop {
                let Some(message) = self.reader.next().await else {
                    return Ok(None);
                };
                let message = message?;
                match message {
                    Message::Text(text) => return Ok(Some(serde_json::from_str(&text)?)),
                    Message::Binary(bytes) => return Ok(Some(serde_json::from_slice(&bytes)?)),
                    Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
                    Message::Close(_) => return Ok(None),
                }
            }
        })
    }
}

pub(crate) struct StdioTransportReader<R> {
    reader: Lines<BufReader<R>>,
}

pub(crate) struct StdioTransportWriter<W> {
    writer: BufWriter<W>,
}

pub(crate) fn stdio_transport<T>(stream: T) -> (BoxTransportWriter, BoxTransportReader)
where
    T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (read_half, write_half) = tokio::io::split(stream);
    (
        Box::new(StdioTransportWriter {
            writer: BufWriter::new(write_half),
        }),
        Box::new(StdioTransportReader {
            reader: BufReader::new(read_half).lines(),
        }),
    )
}

pub(crate) fn stdio_transport_parts<R, W>(
    reader: R,
    writer: W,
) -> (BoxTransportWriter, BoxTransportReader)
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    (
        Box::new(StdioTransportWriter {
            writer: BufWriter::new(writer),
        }),
        Box::new(StdioTransportReader {
            reader: BufReader::new(reader).lines(),
        }),
    )
}

impl<W> TransportWriter for StdioTransportWriter<W>
where
    W: AsyncWrite + Send + Unpin + 'static,
{
    fn send<'a>(
        &'a mut self,
        message: &'a BusMessage,
    ) -> Pin<Box<dyn Future<Output = BusResult<()>> + Send + 'a>> {
        Box::pin(async move {
            let text = serde_json::to_string(message)?;
            self.writer.write_all(text.as_bytes()).await?;
            self.writer.write_all(b"\n").await?;
            self.writer.flush().await?;
            Ok(())
        })
    }

    fn close<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = BusResult<()>> + Send + 'a>> {
        Box::pin(async move {
            self.writer.flush().await?;
            self.writer.shutdown().await?;
            Ok(())
        })
    }
}

impl<R> TransportReader for StdioTransportReader<R>
where
    R: AsyncRead + Send + Unpin + 'static,
{
    fn next<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = BusResult<Option<BusMessage>>> + Send + 'a>> {
        Box::pin(async move {
            let Some(line) = self.reader.next_line().await? else {
                return Ok(None);
            };
            Ok(Some(serde_json::from_str(&line)?))
        })
    }
}
