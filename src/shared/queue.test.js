'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sendMessage,
  receiveMessages,
  deleteMessage,
  getQueueCounts,
} = require('./queue');

function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    send(command) {
      calls.push(command);
      return Promise.resolve(responder(command));
    },
  };
}

test('sendMessage JSON-encodes the body and targets the given queue', async () => {
  const client = fakeClient(() => ({ MessageId: 'm-1' }));
  await sendMessage(client, 'http://queue/alert-fanout', { alertId: 'a-1' });

  assert.equal(client.calls.length, 1);
  const input = client.calls[0].input;
  assert.equal(input.QueueUrl, 'http://queue/alert-fanout');
  assert.equal(input.MessageBody, JSON.stringify({ alertId: 'a-1' }));
});

test('receiveMessages returns an empty array when SQS has nothing to deliver', async () => {
  const client = fakeClient(() => ({}));
  const messages = await receiveMessages(client, 'http://queue/alert-fanout');
  assert.deepEqual(messages, []);
});

test('receiveMessages passes through polling options', async () => {
  const client = fakeClient(() => ({ Messages: [{ Body: '{}' }] }));
  const messages = await receiveMessages(client, 'http://queue/alert-fanout', {
    maxMessages: 5,
    waitTimeSeconds: 2,
    visibilityTimeout: 30,
  });

  const input = client.calls[0].input;
  assert.equal(input.MaxNumberOfMessages, 5);
  assert.equal(input.WaitTimeSeconds, 2);
  assert.equal(input.VisibilityTimeout, 30);
  assert.equal(messages.length, 1);
});

test('deleteMessage targets the queue and receipt handle', async () => {
  const client = fakeClient(() => ({}));
  await deleteMessage(client, 'http://queue/alert-fanout', 'receipt-123');

  const input = client.calls[0].input;
  assert.equal(input.QueueUrl, 'http://queue/alert-fanout');
  assert.equal(input.ReceiptHandle, 'receipt-123');
});

test('getQueueCounts parses visible and in-flight message counts as numbers', async () => {
  const client = fakeClient(() => ({
    Attributes: {
      ApproximateNumberOfMessages: '17',
      ApproximateNumberOfMessagesNotVisible: '3',
    },
  }));
  const counts = await getQueueCounts(client, 'http://queue/alert-fanout');
  assert.deepEqual(counts, { visible: 17, inFlight: 3 });

  const input = client.calls[0].input;
  assert.deepEqual(input.AttributeNames, [
    'ApproximateNumberOfMessages',
    'ApproximateNumberOfMessagesNotVisible',
  ]);
});

test('getQueueCounts defaults both counts to zero when the attributes are missing', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  const counts = await getQueueCounts(client, 'http://queue/alert-fanout');
  assert.deepEqual(counts, { visible: 0, inFlight: 0 });
});

test('getQueueCounts keeps visible and in-flight counts separate rather than combining them', async () => {
  const client = fakeClient(() => ({
    Attributes: {
      ApproximateNumberOfMessages: '5',
      ApproximateNumberOfMessagesNotVisible: '12',
    },
  }));
  const counts = await getQueueCounts(client, 'http://queue/alert-fanout');
  assert.equal(counts.visible, 5);
  assert.equal(counts.inFlight, 12);
});
