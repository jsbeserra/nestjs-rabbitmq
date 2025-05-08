import { Logger } from "@nestjs/common";
import { AmqpConnectionManager, ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import stringify from "faster-stable-stringify";
import { AMQPConnectionManager } from "./manager/amqp-connection-manager";
import { merge, tryParseJson } from "./helper";
import { IRabbitHandler } from "./rabbitmq.interfaces";
import {
  LogType,
  RabbitMQConsumerOptions,
  RabbitMQModuleOptions,
} from "./rabbitmq.types";

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
  private readonly delayExchange: string;
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
      callback: async () => true,
      suffix: ".dlq",
    },
  };

  constructor(
    private readonly connection: AmqpConnectionManager,
    private readonly options: RabbitMQModuleOptions,
    private readonly publishChannel: ChannelWrapper,
  ) {
    this.delayExchange = `${this.options.delayExchangeName}.delay`;
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
    consumer = merge(this.defaultConsumerOptions, consumer);

    return this.connection.createChannel({
      confirm: true,
      name: consumer.queue,
      setup: (channel: ConfirmChannel) => {
        return Promise.all([
          channel.prefetch(consumer.prefetch),
          channel.assertQueue(consumer.queue, {
            durable: consumer.durable,
            autoDelete: consumer.autoDelete,
            deadLetterRoutingKey: `${consumer.queue}${consumer.deadLetterStrategy?.suffix ?? ".dlq"}`,
            deadLetterExchange: "",
          }),
          this.bindQueues(consumer, channel),
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
  }

  private bindQueues(consumer: RabbitMQConsumerOptions, channel: ConfirmChannel): Promise<boolean> {
    return new Promise((resolve) => {
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
    })
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
    const deadletterQueue = `${consumer.queue}${consumer.deadLetterStrategy?.suffix ?? ".dlq"}`;
    await channel.assertQueue(deadletterQueue, { durable: true });
    if (consumer?.retryStrategy?.enabled !== false) {
      await channel.assertExchange(this.delayExchange, "x-delayed-message", {
        durable: true,
        arguments: { "x-delayed-type": "direct" },
      });
      await channel.bindQueue(
        consumer.queue,
        this.delayExchange,
        consumer.queue,
      );
      return
    }

    await channel.unbindQueue(
      consumer.queue,
      this.delayExchange,
      consumer.queue,
    );
  }

  private async processRetry(
    consumer: RabbitMQConsumerOptions,
    message: ConsumeMessage,
  ): Promise<boolean> {
    if (!this.canRetry(consumer)) return false
    const retryCount = message.properties?.headers?.["x-retries-count"] ?? 0;
    const maxRetry = consumer.retryStrategy.maxAttempts;

    if (retryCount < maxRetry) {
      const retryDelay = consumer.retryStrategy.delay(retryCount);
      try {
        return await this.publishChannel.publish(
          this.delayExchange,
          consumer.queue,
          stringify(tryParseJson(message.content.toString("utf8"))),
          {
            headers: {
              ...message.properties.headers,
              "x-retries-count": retryCount + 1,
              "x-delay": retryDelay,
            },
            deliveryMode: 2,
            persistent: true,
          },
        );
      } catch (e) {
        this.logger.error({ message: "could_not_retry", error: e });
        return false
      }
    }
  }

  private canRetry(consumer: RabbitMQConsumerOptions): boolean {
    return consumer.retryStrategy === undefined ||
      consumer.retryStrategy.enabled === undefined ||
      consumer?.retryStrategy.enabled
  }

  private inspectConsumer(args: InspectInput): void {
    const { binding, consumeMessage, data, error } = args;

    const { exchange, routingKey, queue } = binding;
    const { content, fields, properties } = consumeMessage;
    const message = `[AMQP] [CONSUMER] [${exchange}] [${routingKey}] [${queue}]`;
    const logLevel = error ? "error" : "log";

    const logData = {
      logLevel,
      type: "consumer",
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

    if (error) {
      logData["error"] = {
        stack: error?.stack,
        message: error?.message,
        name: error?.name,
      };
    }

    this.logger[logLevel](logData);
  }

  private async ackMessage(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    consumer: RabbitMQConsumerOptions,
    hasErrors: boolean,
    hasRetried: boolean,
  ): Promise<void> {
    if (!AMQPConnectionManager.consumerConn.isConnected()) {
      this.logger.error("Could not acknowledge message, Connection is offline");
      return;
    }
    if (this.canAck(hasErrors, consumer, hasRetried)) {
      channel.ack(message);
    } else if (hasErrors && !hasRetried) {
      let shouldNack = true;
      try {
        shouldNack = await this.shouldNackMessage(consumer, message);
      } catch (e) {
        this.logger.error({
          type: "consumer",
          title: `[AMQP] [DEADLETTER] ${message.fields.exchange} ${message.fields.routingKey} ${message.fields} ${consumer.queue}`,
          error: {
            stack: e?.stack,
            message: e?.message,
            name: e?.name,
          },
        });
      }
      if (shouldNack) {
        channel.nack(message, false, false);
      } else {
        channel.ack(message);
      }
    }
  }

  private canAck(hasErrors: boolean, consumer: RabbitMQConsumerOptions, hasRetried: boolean) {
    return (!hasErrors && consumer?.autoAck) || (hasErrors && hasRetried)
  }

  private async shouldNackMessage(consumer: RabbitMQConsumerOptions, message: ConsumeMessage): Promise<boolean> {
    const deadLetterCallback = consumer.deadLetterStrategy?.callback;
    const messageContent = message.content.toString("utf8");
    const result = await deadLetterCallback(messageContent);
    return result ?? true;
  }
}
