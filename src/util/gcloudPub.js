import {
  ETH_NETWORK_NAME,
  PUBSUB_TOPIC_MISC,
} from '../constant';

const { PubSub } = require('@google-cloud/pubsub');
const uuidv4 = require('uuid/v4');

const config = require('../../config/config');

const pubsub = new PubSub();
const topics = [
  PUBSUB_TOPIC_MISC,
];
const publisher = {};
const publisherWrapper = {};
const ethNetwork = ETH_NETWORK_NAME;

topics.forEach((topic) => {
  publisherWrapper[topic] = pubsub.topic(topic, {
    batching: {
      maxMessages: config.GCLOUD_PUBSUB_MAX_MESSAGES || 10,
      maxMilliseconds: config.GCLOUD_PUBSUB_MAX_WAIT || 1000,
    },
  });
});

/* istanbul ignore next */
publisher.publish = async (publishTopic, req, obj) => {
  if (!config.GCLOUD_PUBSUB_ENABLE) return;
  Object.assign(obj, {
    '@timestamp': new Date().toISOString(),
    appServer: config.APP_SERVER || 'test-store',
    ethNetwork,
    uuidv4: uuidv4(),
    requestIP: req ? (req.headers['x-real-ip'] || req.ip) : undefined,
    agent: req ? (req.headers['x-ucbrowser-ua'] || req.headers['user-agent']) : undefined,
    deviceId: req ? (req.headers['x-device-id']) : undefined,
    requestUrl: req ? req.originalUrl : undefined,
  });

  const data = JSON.stringify(obj);
  const dataBuffer = Buffer.from(data);
  try {
    await publisherWrapper[publishTopic].publish(dataBuffer);
  } catch (err) {
    console.error('ERROR:', err);
  }
};

export default publisher;
