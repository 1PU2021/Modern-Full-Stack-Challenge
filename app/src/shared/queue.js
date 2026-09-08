'use strict';

const {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} = require('@aws-sdk/client-sqs');

function createQueueClient({ region, endpoint }) {
  return new SQSClient({
    region,
    ...(endpoint ? { endpoint } : {}),
  });
}

async function sendMessage(client, queueUrl, body, { abortSignal } = {}) {
  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(body),
  });
  return client.send(command, abortSignal ? { abortSignal } : undefined);
}

async function receiveMessages(
  client,
  queueUrl,
  { maxMessages = 10, waitTimeSeconds = 10, visibilityTimeout, abortSignal } = {}
) {
  const command = new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: maxMessages,
    WaitTimeSeconds: waitTimeSeconds,
    ...(visibilityTimeout !== undefined ? { VisibilityTimeout: visibilityTimeout } : {}),
  });
  const response = await client.send(command, abortSignal ? { abortSignal } : undefined);
  return response.Messages || [];
}

async function deleteMessage(client, queueUrl, receiptHandle) {
  const command = new DeleteMessageCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle,
  });
  return client.send(command);
}

async function getQueueCounts(client, queueUrl) {
  const command = new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  });
  const response = await client.send(command);
  return {
    visible: Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

module.exports = {
  createQueueClient,
  sendMessage,
  receiveMessages,
  deleteMessage,
  getQueueCounts,
};
