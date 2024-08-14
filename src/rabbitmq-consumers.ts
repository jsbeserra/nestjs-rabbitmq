import { AmqpConnectionManager, ChannelWrapper } from "amqp-connection-manager";
import { IRabbitHandler } from "./rabbitmq.interfaces";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import {
  LogType,
  RabbitMQConsumerOptions,
  RabbitMQModuleOptions,
} from "./rabbitmq.types";
import { Logger } from "@nestjs/common";

type InspectInput = {
  consumeMessage: ConsumeMessage;
  data?: any;
  binding: { exchange: string; routingKey: string; queue: string };
  error?: any;
};

export class RabbitMQConsumer {
  private logger = new Logger(RabbitMQConsumer.name);

  private readonly connection: AmqpConnectionManager;
  private readonly options: RabbitMQModuleOptions;
  private readonly delayExchange: string;
  private readonly publishChannel: ChannelWrapper;
  private readonly logType: LogType;
  private defaultConsumerOptions: Partial<RabbitMQConsumerOptions> = {
    autoAck: true,
    durable: true,
    prefetch: 10,
    autoDelete: false,
  };

  constructor(
    connection: AmqpConnectionManager,
    options: RabbitMQModuleOptions,
    publishChannelWrapper: ChannelWrapper,
  ) {
    this.connection = connection;
    this.options = options;
    this.delayExchange = `${this.options.delayExchangeName}.delay`;
    this.publishChannel = publishChannelWrapper;

    this.logType =
      (process.env.RABBITMQ_TRAFFIC_TYPE as LogType) ??
      this.options.extraOptions.logType;
  }

  public async createConsumer(
    consumer: RabbitMQConsumerOptions,
    messageHandler: IRabbitHandler,
  ): Promise<ChannelWrapper> {
    consumer = {
      ...this.defaultConsumerOptions,
      ...consumer,
    };
    const consumerChannel = this.connection.createChannel({
      confirm: true,
      name: consumer.queue,
      setup: (channel: ConfirmChannel) => {
        return Promise.all([
          channel.prefetch(consumer.prefetch),
          channel.assertQueue(consumer.queue, {
            durable: consumer.durable,
            autoDelete: consumer.autoDelete,
            deadLetterRoutingKey: `${consumer.queue}${consumer.suffixOptions?.dlqSuffix ?? ".dlq"}`,
            deadLetterExchange: "",
          }),

          channel.bindQueue(
            consumer.queue,
            consumer.exchangeName,
            consumer.routingKey,
          ),

          this.attachRetryAndDLQ(channel, consumer),

          channel.consume(consumer.queue, async (message) => {
            await this.processConsumerMessage(
              message,
              channel,
              consumer,
              messageHandler,
            );
          }),
        ]);
      },
    });

    return consumerChannel;
  }

  private async processConsumerMessage(
    message: ConsumeMessage,
    channel: ConfirmChannel,
    consumer: RabbitMQConsumerOptions,
    callback: IRabbitHandler,
  ): Promise<void> {
    let hasErrors = null;

    try {
      await callback(JSON.parse(message.content.toString("utf8")), {
        message,
        channel,
        queue: consumer.queue,
      });

      if (consumer.autoAck) {
        channel.ack(message);
      }
    } catch (e) {
      hasErrors = e;
      await this.processRetry(consumer, message, channel);
    } finally {
      if (["consumer", "all"].includes(this.logType) || hasErrors)
        this.inspectConsumer({
          binding: {
            queue: consumer.queue,
            routingKey: message.fields.routingKey ?? consumer.routingKey,
            exchange: consumer.exchangeName,
          },
          consumeMessage: message,
          error: hasErrors,
        });
    }
  }

  private async attachRetryAndDLQ(
    channel: ConfirmChannel,
    consumer: RabbitMQConsumerOptions,
  ): Promise<void> {
    const deadletterQueue = `${consumer.queue}${consumer.suffixOptions?.dlqSuffix ?? ".dlq"}`;
    await channel.assertQueue(deadletterQueue, { durable: true });

    if (consumer?.retryStrategy?.enabled == false) {
      await channel.unbindQueue(
        consumer.queue,
        this.delayExchange,
        consumer.queue,
      );
    } else {
      await channel.assertExchange(this.delayExchange, "x-delayed-message", {
        durable: true,
        arguments: { "x-delayed-type": "direct" },
      });
      await channel.bindQueue(
        consumer.queue,
        this.delayExchange,
        consumer.queue,
      );
    }
  }

  private async processRetry(
    consumer: RabbitMQConsumerOptions,
    message: ConsumeMessage,
    channel: ConfirmChannel,
  ): Promise<void> {
    if (
      consumer.retryStrategy === undefined ||
      consumer.retryStrategy.enabled === undefined ||
      consumer?.retryStrategy.enabled
    ) {
      const retryCount = message.properties?.headers?.["retriesCount"] ?? 1;
      const maxRetry = consumer?.retryStrategy?.maxAttempts ?? 5;

      if (retryCount <= maxRetry) {
        const retryDelay = consumer?.retryStrategy?.delay?.(retryCount) ?? 5000;

        try {
          const isPublished = await this.publishChannel.publish(
            this.delayExchange,
            consumer.queue,
            JSON.stringify(JSON.parse(message.content.toString("utf8"))),
            {
              headers: {
                ...message.properties.headers,
                retriesCount: retryCount + 1,
                "x-delay": retryDelay,
              },
            },
          );

          if (isPublished) {
            channel.ack(message);
            return;
          }
        } catch (e) {
          this.logger.error(
            JSON.stringify({ message: "could_not_retry", error: e }),
          );
          channel.nack(message);
        }
      }
    }

    channel.nack(message, false, false);
  }

  private inspectConsumer(args: InspectInput): void {
    const { binding, consumeMessage, data, error } = args;

    const { exchange, routingKey, queue } = binding;
    const { content, fields, properties } = consumeMessage;
    const message = `[AMQP] [CONSUMER] [${exchange}] [${routingKey}] [${queue}]`;
    const logLevel = error ? "error" : "log";

    const logData = {
      logLevel,
      correlationId: args?.consumeMessage?.properties?.correlationId,
      binding,
      title: message,
      message: {
        fields,
        properties,
        content: data ?? JSON.parse(content.toString("utf8")),
      },
    };

    if (error)
      Object.assign(logData, { error: error.message ?? error.toString() });

    this.logger[logLevel](JSON.stringify(logData));

    // this.logger[logLevel]({ message, amqp: logData });
  }
}
