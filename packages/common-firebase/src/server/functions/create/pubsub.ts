import { onMessagePublished, type MessagePublishedData, type Message, type PubSubOptions } from 'firebase-functions/v2/pubsub';
import type { CloudEvent } from 'firebase-functions/v2/core';
import type { EndpointSettings } from '../../../functions/interface.js';
import { mergeEndpointSettings } from './helpers.js';

export type PubSubTopicListener = (message: Message<unknown>, event: CloudEvent<MessagePublishedData>) => void | Promise<void>;

export function createTopicListener(topicName: string, listener: PubSubTopicListener, options: EndpointSettings | null = null) {
    const pubsubOpts: PubSubOptions = {
        topic: topicName,
        ...mergeEndpointSettings(options),
    };
    return onMessagePublished(pubsubOpts, (event) => listener(event.data.message, event));
}
