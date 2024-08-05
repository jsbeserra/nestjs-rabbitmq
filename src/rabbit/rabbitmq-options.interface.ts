import { ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
export type RabbitConsumerParameters = {
  message: ConsumeMessage;
  channel: ConfirmChannel;
  queue: string;
};
export type LogType = "all" | "consumer" | "publisher" | "none";

export interface IRabbitHandler<T = any> {
  (content: T, parameters?: RabbitConsumerParameters): Promise<void>;
}

export interface IDelayProgression {
  (attempt: number): number;
}

export type RabbitMQExchangeTypes = "direct" | "topic" | "fanout" | "headers";

export type RabbitMQConsumerOptions = {
  /** Declare the queue parameters and operation */
  /** Name of the Queue */
  queue: string;
  /** The SDK will send an ACK at the end of the consumer function
   * If *disabled* your consumer will need to call channel.ack() manually !
   * Default: true*/
  autoAck?: boolean;
  /** Amount of messages that will be delivered to the consumer at once
   * Default: 10 */
  prefetch?: number;
  /** If messages enqueued on the queue will be stored on a persistent disk
   * **WARNING**: If this option is disabled, Rabbit will store the messages in-memory. If RabbitMQ goes offline while messages are enqueued, they will be lost!
   * Default: true */
  durable?: boolean;

  /** If the queue needs to be automatically deleted when there are no consumers attached.
   * **WARNING**: RabbitMQ will delete the queue no matter the amount of messages enqueued.
   * Default: false */
  autoDelete?: boolean;

  /** By definition, every queue needs to be attached to an Exchange. Here you can declare the exchange */
  // exchangeOptions: {
  /** Name of the Exchange */
  exchangeName: string;

  /** Routing key between the Queue and the exchange. This acts as a filter so only this routing key will be received by the queue.
   * For exchanges of the type `fanout` this parameter will be ignored
   * This parameter accepts patterns
   *   E.g: webhook.`#` - Routes all messages that contains at least `webhook` in the routing key. (webhooks, webhooks.test)
   *        webhook.\*.test - Routes all messages that contains the described patter (webhook.ABC.test, webhook.123.test) */
  routingKey: string;

  /** When the consumer throwns an error. The message will be automatically enqueued to a retry queue. Here you declare the strategies for retrying */
  retryStrategy?: {
    /** If the retry strategy will be executed.
     * Default: true */
    enabled?: boolean;
    /** Maximum amount of attempts before sending the message do the DLQ
     * Default: 5 */
    maxAttempts?: number;
    /** The delay amount in MS before the retry sends the message to the original queue
     * Default: 5000*/
    delay?: IDelayProgression;
  };

  /** Override default suffix that are defined in this library */
  suffixOptions?: {
    exchangeSuffix?: string;
    dlqSuffix?: string;
  };
};

export type RabbitConnectionOptions = {
  urls: string | string[];
  // appName: string;
};

export type RabbitMQAssertExchange = {
  /** Name of the exchange to be asserted.
   * An automatic `.exchange` will be appended to the name in case the exchange name does not have it */
  name: string;

  /** Assert the type of the exchange.
   * For more information about exchange types: https://www.rabbitmq.com/tutorials/amqp-concepts
   * */
  type: RabbitMQExchangeTypes;

  options?: {
    /** If messages that passes through this exchange should be stored on a persistent disk
     *  **WARNING**: If this option is disabled, Rabbit will store the messages in-memory. If RabbitMQ goes offline while messages are enqueued, they will be lost!
     * Default: true */
    durable?: boolean;

    /** If the queue needs to be automatically deleted when there are no consumers attached.
     * **WARNING**: RabbitMQ will delete the queue no matter the amount of messages enqueued.
     * Default: false */
    autoDelete?: boolean;

    /** Override default suffix that are defined in this library.
     * Default: '.exchange'*/
    exchangeSufix?: string;

    /** Declare the exchange as a delayed one, in this scenario the exchange will be declated as a `x-delayed-message` with an argument `x-delayed-type: ${type}`
     * Default: false */
    isDelayed?: boolean;
  };
};

export type RabbitMQConsumerChannel = {
  options: RabbitMQConsumerOptions;

  /** Callback bind that will be declared as consumer
   * This handler will follow the `IRabbitHandler` interface
   * E.g: messageHandler: this.yourService.messageHandler.bind(this.yourService)
   */
  messageHandler: IRabbitHandler;
};

export type RabbitMQModuleOptions = {
  /** Connection URI for the RabbitMQ server
   * E.g: amqp://{user}:{password}@{url}/{vhost} */
  connectionString: string | string[];

  /** The name of the squad you belong */
  delayExchangeName: string;

  /** When **TRUE** the SDK will not initiate the consumers automatically during the _OnModuleInit_
   * To initiate the consumer, you can call it at the end of the `bootstrap()` on your `main.ts` file
   * ```javascript
   * const rabbitService: RabbitMQService = app.get(RabbitMQService);
   * await rabbitService.beginConsumers();
   * ```
   * Default: false */
  consumerManualLoad?: boolean;

  /** When **TRUE**, the connection will be made synchronously during the `OnModuleInit` lifecycle
   * and will only return after the connection is sucessfully made
   * When **FALSE**, the connection is made asynchronously and will release the lifecycle event as fast as possible.
   * Default: true */
  waitConnection?: boolean;

  /** All exchanges declared here will be validated before attaching the consumers
   * If any of the exchanegs declared can not be asserted an error will be thrown */
  assertExchanges?: Array<RabbitMQAssertExchange>;

  /** Enables the message inspection of different parts of the RabbitMQ
   * this option can be overriden by using the env RABBITMQ_TRAFFIC_TYPE */
  trafficInspection?: LogType;

  /** Array of consumers that will be attached to the application*/
  consumerChannels?: Array<RabbitMQConsumerChannel>;
};

export interface RabbitOptionsFactory {
  createRabbitOptions(): RabbitMQModuleOptions;
}

export interface RabbitChannel {
  exchangeType: string;
  wrapper: ChannelWrapper;
}

export type PublishOptions = {
  expiration?: string | number | undefined;
  userId?: string | undefined;
  CC?: string | string[] | undefined;

  mandatory?: boolean | undefined;
  persistent?: boolean | undefined;
  deliveryMode?: boolean | number | undefined;
  BCC?: string | string[] | undefined;

  contentType?: string | undefined;
  contentEncoding?: string | undefined;
  headers?: any;
  priority?: number | undefined;
  correlationId?: string | undefined;
  replyTo?: string | undefined;
  messageId?: string | undefined;
  timestamp?: number | undefined;
  type?: string | undefined;
  appId?: string | undefined;
  timeout?: number;
};
