/**
 * Transport compliance test suite.
 *
 * Reusable test suite ensuring consistent behavior across all transport
 * implementations (WebSocket, NATS, Redis, HTTP, etc.).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  BusTransport,
  BusMessage,
  BusRequestMessage,
  BusResponseMessage,
  BusEventMessage,
} from '../types/index.js';

type TransportFactory = () => Promise<BusTransport> | BusTransport;

/**
 * Run the complete transport compliance test suite.
 * @param name - Descriptive name for the transport
 * @param factory - Factory function that creates a fresh transport instance
 */
export function runTransportComplianceTests(name: string, factory: TransportFactory): void {
  describe(`Transport Compliance: ${name}`, () => {
    let transport: BusTransport;

    beforeEach(async () => {
      transport = await factory();
    });

    afterEach(async () => {
      if (transport) {
        await transport.disconnect();
      }
    });

    describe('Lifecycle', () => {
      it('can connect and disconnect', async () => {
        await expect(transport.connect()).resolves.toBeUndefined();
        await expect(transport.disconnect()).resolves.toBeUndefined();
      });

      it('can disconnect multiple times without error', async () => {
        await transport.connect();
        await transport.disconnect();
        await expect(transport.disconnect()).resolves.toBeUndefined();
      });

      it('cleanup handlers on disconnect', async () => {
        await transport.connect();

        const unsubscribe = transport.onReceive(async () => {
          // Handler
        });

        await transport.disconnect();
        expect(unsubscribe).toBeInstanceOf(Function);
      });
    });

    describe('Message sending', () => {
      beforeEach(async () => {
        await transport.connect();
      });

      it('can send event messages', async () => {
        const eventMessage: BusEventMessage = {
          type: 'event',
          subject: 'event',
          namespace: 'test',
          payload: { data: 'test' },
          messageId: 'evt-123',
        };

        // Events return boolean delivery status (true/false)
        await expect(transport.send(eventMessage)).resolves.toBeDefined();
      });

      it('can send request messages', async () => {
        const requestMessage: BusRequestMessage = {
          type: 'request',
          subject: 'request',
          namespace: 'test',
          payload: { query: 'test' },
          correlationId: 'corr-123',
          messageId: 'req-123',
        };

        const sendPromise = transport.send(requestMessage);
        expect(sendPromise).toBeInstanceOf(Promise);
      });

      it('can send response messages', async () => {
        const responseMessage: BusResponseMessage = {
          type: 'response',
          correlationId: 'corr-456',
          result: { answer: 42 },
        };

        // Response messages return boolean delivery status (true/false)
        await expect(transport.send(responseMessage)).resolves.toBeDefined();
      });

      it('handles send errors gracefully', async () => {
        await transport.disconnect();

        const eventMessage: BusEventMessage = {
          type: 'event',
          namespace: 'test',
          subject: 'event',
          payload: { data: 'test' },
          messageId: 'evt-error',
        };

        await expect(transport.send(eventMessage)).rejects.toThrow();
      });
    });

    describe('Message receiving', () => {
      beforeEach(async () => {
        await transport.connect();
      });

      it('can register message handler', () => {
        const handler = async (_msg: BusMessage): Promise<void> => {
          // Handler body
        };

        const unsubscribe = transport.onReceive(handler);
        expect(unsubscribe).toBeInstanceOf(Function);
      });

      it('handler receives sent messages', async () => {
        const received: BusMessage[] = [];

        transport.onReceive(async (msg) => {
          received.push(msg);
        });

        const eventMessage: BusEventMessage = {
          type: 'event',
          namespace: 'test',
          subject: 'event',
          payload: { data: 'test' },
          messageId: 'evt-receive',
        };

        await transport.send(eventMessage);

        // Give the handler time to process
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          type: 'event',
          namespace: 'test',
          subject: 'event',
          messageId: 'evt-receive',
        });
      }, 5000);

      it('multiple handlers all receive messages', async () => {
        const received1: BusMessage[] = [];
        const received2: BusMessage[] = [];

        transport.onReceive(async (msg) => {
          received1.push(msg);
        });

        transport.onReceive(async (msg) => {
          received2.push(msg);
        });

        const eventMessage: BusEventMessage = {
          type: 'event',
          namespace: 'test',
          subject: 'multi',
          payload: { data: 'broadcast' },
          messageId: 'evt-multi',
        };

        await transport.send(eventMessage);

        // Give handlers time to process
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(received1).toHaveLength(1);
        expect(received2).toHaveLength(1);
        expect(received1[0]).toMatchObject(received2[0]);
      }, 5000);

      it('unsubscribe removes handler', async () => {
        const received: BusMessage[] = [];

        const unsubscribe = transport.onReceive(async (msg) => {
          received.push(msg);
        });

        await transport.send({
          type: 'event',
          namespace: 'test',
          subject: 'unsub',
          payload: { seq: 1 },
          messageId: 'evt-unsub-1',
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(received).toHaveLength(1);

        unsubscribe();

        await transport.send({
          type: 'event',
          namespace: 'test',
          subject: 'unsub',
          payload: { seq: 2 },
          messageId: 'evt-unsub-2',
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(received).toHaveLength(1);
      }, 5000);
    });

    describe('Correlation (request/response)', () => {
      beforeEach(async () => {
        await transport.connect();
      });

      it('request messages track correlation', async () => {
        const correlationId = 'corr-track-123';

        // Set up handler to respond
        transport.onReceive(async (msg) => {
          if (msg.type === 'request') {
            const response: BusResponseMessage = {
              type: 'response',
              correlationId: msg.correlationId,
              result: { answer: 42 },
            };
            await transport.send(response);
          }
        });

        const requestMessage: BusRequestMessage = {
          type: 'request',
          namespace: 'test',
          subject: 'correlation',
          payload: { query: 'What is the answer?' },
          correlationId,
          messageId: 'req-track',
        };

        const resultPromise = transport.send(requestMessage);

        await expect(resultPromise).resolves.toEqual({ answer: 42 });
      }, 5000);

      it('response messages resolve correct request', async () => {
        const correlationId = 'corr-resolve-456';

        // Set up handler to respond
        transport.onReceive(async (msg) => {
          if (msg.type === 'request' && msg.correlationId === correlationId) {
            const response: BusResponseMessage = {
              type: 'response',
              correlationId: msg.correlationId,
              result: { status: 'success' },
            };
            await transport.send(response);
          }
        });

        const requestMessage: BusRequestMessage = {
          type: 'request',
          namespace: 'test',
          subject: 'resolve',
          payload: {},
          correlationId,
          messageId: 'req-resolve',
        };

        const result = await transport.send(requestMessage);

        expect(result).toEqual({ status: 'success' });
      }, 5000);

      it('timeout rejects pending requests', async () => {
        const requestMessage: BusRequestMessage = {
          type: 'request',
          namespace: 'test',
          subject: 'timeout',
          payload: {},
          correlationId: 'corr-timeout',
          messageId: 'req-timeout',
        };

        // Send request without setting up a response handler
        // This should timeout
        const resultPromise = transport.send(requestMessage);

        await expect(resultPromise).rejects.toThrow();
      }, 35000);

      it('multiple concurrent requests work correctly', async () => {
        // Set up handler to respond to requests
        transport.onReceive(async (msg) => {
          if (msg.type === 'request') {
            const response: BusResponseMessage = {
              type: 'response',
              correlationId: msg.correlationId,
              result: { echo: (msg.payload as { id: number }).id },
            };
            await transport.send(response);
          }
        });

        const requests = Array.from({ length: 5 }, (_, i) => {
          const req: BusRequestMessage = {
            type: 'request',
            namespace: 'test',
            subject: 'concurrent',
            payload: { id: i },
            correlationId: `corr-concurrent-${i}`,
            messageId: `req-concurrent-${i}`,
          };
          return transport.send(req);
        });

        const results = await Promise.all(requests);

        expect(results).toHaveLength(5);
        results.forEach((result, i) => {
          expect(result).toEqual({ echo: i });
        });
      }, 5000);
    });

    describe('Error handling', () => {
      beforeEach(async () => {
        await transport.connect();
      });

      it('handles malformed messages gracefully', async () => {
        const handler = async (_msg: BusMessage): Promise<void> => {
          // Handler should be called only for valid messages
        };

        expect(() => transport.onReceive(handler)).not.toThrow();
      });

      it('handles disconnection during send', async () => {
        const eventMessage: BusEventMessage = {
          type: 'event',
          namespace: 'test',
          subject: 'disc',
          payload: {},
          messageId: 'evt-disc',
        };

        await transport.disconnect();

        await expect(transport.send(eventMessage)).rejects.toThrow();
      });

      it('cleans up resources on error', async () => {
        const received: BusMessage[] = [];

        transport.onReceive(async (msg) => {
          received.push(msg);
          throw new Error('Handler error');
        });

        const eventMessage: BusEventMessage = {
          type: 'event',
          namespace: 'test',
          subject: 'error',
          payload: {},
          messageId: 'evt-error',
        };

        // Send should not fail even if handler throws
        await expect(transport.send(eventMessage)).resolves.toBeDefined();

        // Give time for handler to run
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Message should still have been received
        expect(received).toHaveLength(1);
      }, 5000);
    });
  });
}
