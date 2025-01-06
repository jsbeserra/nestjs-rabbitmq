import { Logger } from "@nestjs/common";
import { AmqpConnectionManager, ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import { tryParseJson } from "./helper";
import { IRabbitHandler } from "./rabbitmq.interfaces";
import {
  LogType,
  RabbitMQConsumerOptions,
  RabbitMQModuleOptions,
} from "./rabbitmq.types";
import { AMQPConnectionManager } from "./amqp-connection-manager";

type InspectInput = {
  consumeMessage: ConsumeMessage;
  data?: any;
  binding: { exchange: string; routingKey: string; queue: string };
  elapsedTime: bigint;
  error?: any;
  isDead: boolean;
};

export class RabbitMQConsumer {
  private logger: Console | Logger;

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
    retryStrategy: {
      enabled: true,
      maxAttempts: 5,
      delay: () => 5000,
    },
    deadLetterStrategy: {
      enabled: true,
      callback: async () => true,
      suffix: ".dlq",
    },
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
      (process.env.RABBITMQ_LOG_TYPE as LogType) ??
      this.options.extraOptions.logType;

    this.logger =
      options?.extraOptions?.loggerInstance ??
      new Logger(RabbitMQConsumer.name);
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
            deadLetterRoutingKey: `${consumer.queue}${consumer.deadLetterStrategy.suffix}`,
            deadLetterExchange: "",
          }),

          new Promise((resolve) => {
            if (typeof consumer.routingKey === "object") {
              for (const rk of consumer.routingKey) {
                channel.bindQueue(consumer.queue, consumer.exchangeName, rk);
              }
            } else {
              channel.bindQueue(
                consumer.queue,
                consumer.exchangeName,
                consumer.routingKey,
              );
            }

            resolve(true);
          }),

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
    let hasRetried = false;
    const start = process.hrtime.bigint();

    try {
      await callback(tryParseJson(message.content.toString("utf8")), {
        message,
        channel,
        queue: consumer.queue,
      });
    } catch (e) {
      hasErrors = e;
      hasRetried = await this.processRetry(consumer, message);
    } finally {
      if (["consumer", "all"].includes(this.logType) || hasErrors)
        this.inspectConsumer({
          binding: {
            queue: consumer.queue,
            routingKey: message.fields.routingKey,
            exchange: consumer.exchangeName,
          },
          consumeMessage: message,
          error: hasErrors,
          elapsedTime: process.hrtime.bigint() - start,
          isDead: hasErrors && !hasRetried,
        });

      this.ackMessage(channel, message, consumer, hasErrors, hasRetried);
    }
  }

  private async attachRetryAndDLQ(
    channel: ConfirmChannel,
    consumer: RabbitMQConsumerOptions,
  ): Promise<void> {
    const deadletterQueue = `${consumer.queue}${consumer.deadLetterStrategy.suffix}`;
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
  ): Promise<boolean> {
    let isPublished = false;

    if (
      consumer.retryStrategy === undefined ||
      consumer.retryStrategy.enabled === undefined ||
      consumer?.retryStrategy.enabled
    ) {
      const retryCount = message.properties?.headers?.["retriesCount"] ?? 0;
      const maxRetry = consumer.retryStrategy.maxAttempts;

      if (retryCount < maxRetry) {
        const retryDelay = consumer.retryStrategy.delay(retryCount);

        try {
          isPublished = await this.publishChannel.publish(
            this.delayExchange,
            consumer.queue,
            JSON.stringify(tryParseJson(message.content.toString("utf8"))),
            {
              headers: {
                ...message.properties.headers,
                retriesCount: retryCount + 1,
                "x-delay": retryDelay,
              },
            },
          );
        } catch (e) {
          this.logger.error({ message: "could_not_retry", error: e });
          isPublished = false;
        }
      }
    }

    return isPublished;
  }

  private inspectConsumer(args: InspectInput): void {
    const { binding, consumeMessage, data, error } = args;

    const { exchange, routingKey, queue } = binding;
    const { content, fields, properties } = consumeMessage;
    const message = `[AMQP] [CONSUMER] [${exchange}] [${routingKey}] [${queue}]`;
    const logLevel = error ? "error" : "log";

    const logData = {
      logLevel,
      duration: args.elapsedTime.toString(),
      correlationId: args?.consumeMessage?.properties?.correlationId,
      binding,
      title: message,
      isDead: args.isDead,
      consumedMessage: {
        fields,
        properties,
        content: data ?? tryParseJson(content.toString("utf8")),
      },
    };

    if (error)
      Object.assign(logData, { error: error.message ?? error.toString() });

    this.logger[logLevel](JSON.stringify(logData));
  }

  private async ackMessage(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    consumer: RabbitMQConsumerOptions,
    hasErrors: boolean,
    hasRetried: boolean,
  ): Promise<void> {
    if (!AMQPConnectionManager.connection.isConnected()) {
      this.logger.error("Could not acknowledge message, Connection is offline");
      return;
    }

    if ((!hasErrors && consumer.autoAck) || (hasErrors && hasRetried)) {
      channel.ack(message);
    } else if (hasErrors && !hasRetried) {
      let shouldNack = true;

      try {
        shouldNack = await consumer.deadLetterStrategy.callback(
          message.content.toString("utf8"),
        );
      } catch (e) {
        this.logger.error({
          logLevel: "error",
          title: `[AMQP] [DEADLETTER] ${message.fields.exchange} ${message.fields.routingKey} ${message.fields} ${consumer.queue}`,
          error: e.message ?? e.toString(),
        });
      }

      if (shouldNack) channel.nack(message, false, false);
    }
  }
}
