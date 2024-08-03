import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import {
  AmqpConnectionManager,
  ChannelWrapper,
  connect,
} from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage, Message } from "amqplib";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  IRabbitHandler,
  LogType,
  PublishOptions,
  RabbitMQConsumerOptions,
  RabbitMQModuleOptions,
  RabbitOptionsFactory,
} from "./rabbitmq-options.interface";

export const sleep = (ms: number = 200) => {
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      resolve();
    }, ms),
  );
};

type InspectInput = {
  consumeMessage: ConsumeMessage;
  data?: any;
  binding: { exchange: string; routingKey: string; queue: string };
  error?: any;
};

@Injectable()
export class RabbitMQService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger = new Logger(RabbitMQService.name);
  private rabbitTerminalErrors = [
    "channel-error",
    "precondition-failed",
    "not-allowed",
    "access-refused",
    "closed via management plugin",
  ];
  private logType: LogType = "none";
  private rabbitModuleOptions: RabbitOptionsFactory;
  private publishChannelWrapper: ChannelWrapper = null;
  private connection: AmqpConnectionManager;
  private connectionBlocked: { isBlocked: boolean; reason: string } = {
    isBlocked: false,
    reason: "",
  };
  private delayExchange: string;

  constructor(@Inject("RABBIT_OPTIONS") options: RabbitOptionsFactory) {
    this.rabbitModuleOptions = options;
  }

  async onModuleInit() {
    const options = this.rabbitModuleOptions.createRabbitOptions();
    this.delayExchange = `${options.squadName}.delay.exchange`;
    this.logType =
      (process.env.RABBITMQ_TRAFFIC_TYPE as LogType) ??
      options.trafficInspection ??
      "none";

    if (process.env.NODE_ENV != "test") {
      return this.connect(options);
    }
  }

  async onApplicationShutdown() {
    this.logger.log("Closing RabbitMQ Connection");
    await this?.connection?.close();
  }

  /**
   * Publishes a message to the broker. Every published message needs its exchange and routingKey to be properly routed
   * @param {string} exchangeName - Name of the exchange
   * @param {string} routingKey - Publish routing key
   * @param {T} the message that will be published to RabbitMQ. All messages will be transformed to JSON.
   * @param {PublishOptions} options - Any custom options that you want to send with the message such as headers or properties
   * @returns {Promise<boolean>} Returns a promise of confirmation.
   * If **TRUE** it means that the message arrived and was successfully delivered to an exchange or queue.
   * If **FALSE** or an error is thrown, the message was not published !
   */
  public async publish<T = any>(
    exchangeName: string,
    routingKey: string,
    message: T,
    options?: PublishOptions,
  ): Promise<boolean> {
    let hasErrors = null;

    try {
      if (this.connection) {
        await this.waitForBlockedConnection();
        return this.publishChannelWrapper.publish(
          exchangeName,
          routingKey,
          JSON.stringify(message),
          {
            correlationId: randomUUID(),
            ...options,
            headers: { "x-delay": 0, ...options?.headers },
          },
        );
      } else {
        throw new Error("Connection with RabbitMQ is closed. Cannot publish");
      }
    } catch (e) {
      hasErrors = e;
    } finally {
      this.inspectPublisher(
        exchangeName,
        routingKey,
        message,
        options,
        hasErrors,
      );
    }

    return !hasErrors;
  }

  /**
   * Check status of the main conenection to the broker.
   * @returns {number} 1 - Online | 0 - Offline
   */
  public checkHealth(): number {
    return this.connection.isConnected() ? 1 : 0;
  }

  /**
   * Parse Rabbit message content to typed JSON object
   * @param {Message} The raw message from RabbitMQ
   * @returns {T} the typed message based on <T>
   */
  public static parse<T>(message: Message): T {
    if (!message) return null;

    try {
      return JSON.parse(message.content.toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  private async connect(options: RabbitMQModuleOptions) {
    await new Promise((resolve) => {
      this.connection = connect(options.connectionString, {
        heartbeatIntervalInSeconds: 5,
        reconnectTimeInSeconds: 5,
        connectionOptions: {
          keepAlive: true,
          keepAliveDelay: 5000,
          servername: hostname(),
          clientProperties: {
            connection_name: `${process.env.npm_package_name}-${hostname()}`,
          },
        },
      });

      this.attachEvents(resolve, options);
    });

    await this.registerPublisherAndConsumers(options);
  }

  private attachEvents(resolve, options: RabbitMQModuleOptions) {
    if (options?.waitConnection === false) resolve(true);

    this.connection.on("connect", async ({ url }: { url: string }) => {
      this.logger.log(
        `Rabbit connected to ${url.replace(
          new RegExp(url.replace(/amqp:\/\/[^:]*:([^@]*)@.*?$/i, "$1"), "g"),
          "***",
        )}`,
      );
      resolve(true);
    });

    this.connection.on("disconnect", ({ err }) => {
      console.warn(`Disconnected from rabbitmq: ${err.message}`);

      if (
        this.rabbitTerminalErrors.some((errorMessage) =>
          err.message.toLowerCase().includes(errorMessage),
        )
      ) {
        this.connection.close();
        console.error(
          "RabbitMQ Disconnected with a terminal error, impossible to reconnect",
        );
      }
    });

    this.connection.on("connectFailed", ({ err }) => {
      console.error(`Failure to connect to RabbitMQ instance: ${err.message}`);
    });

    this.connection.on("blocked", ({ reason }) => {
      console.error(`RabbitMQ broker is blocked with reason: ${reason}`);
      this.connectionBlocked = { isBlocked: true, reason };
    });

    this.connection.on("unblocked", () => {
      console.error(
        `RabbitMQ broker connection is unblocked, last reason was: ${this.connectionBlocked?.reason}`,
      );
      this.connectionBlocked = { isBlocked: false, reason: "" };
    });
  }

  private async waitForBlockedConnection(): Promise<void> {
    let retry = 0;
    while (this.connectionBlocked.isBlocked && retry <= 60) {
      console.warn(
        "RabbitMQ connection is blocked, waiting 1s before trying again",
      );
      retry++;
      await sleep(1000);
    }

    if (retry >= 60) {
      throw new Error(
        `RabbitMQ connection is still blocked, cannot publish message. Reason: ${this.connectionBlocked?.reason}`,
      );
    }
  }

  private async assertExchanges(options: RabbitMQModuleOptions) {
    this.publishChannelWrapper = this.connection.createChannel({
      name: `${process.env.npm_package_name}_publish`,
      confirm: true,
      publishTimeout: 60000,
    });

    await this.publishChannelWrapper.addSetup(
      async (channel: ConfirmChannel) => {
        for (const publisher of options?.assertExchanges ?? []) {
          const exchangeName = publisher.name.endsWith(
            publisher.options?.exchangeSufix ?? ".exchange",
          )
            ? publisher.name
            : `${publisher.name}${publisher.options?.exchangeSufix ?? ".exchange"}`;

          const isDelayed = publisher.options?.isDelayed ?? false;
          const type = isDelayed ? "x-delayed-message" : publisher.type;
          const argument = isDelayed
            ? { arguments: { "x-delayed-type": publisher.type } }
            : null;

          await channel.assertExchange(exchangeName, type, {
            durable: publisher?.options?.durable ?? true,
            autoDelete: publisher?.options?.autoDelete ?? false,
            ...argument,
          });
        }
      },
    );
  }

  private async registerPublisherAndConsumers(options: RabbitMQModuleOptions) {
    await this.assertExchanges(options);

    if (options?.consumerChannels?.length > 0) {
      for (const consumer of options?.consumerChannels ?? []) {
        await this.createConsumer(consumer.options, consumer.messageHandler);
      }
    }
  }

  private async createConsumer(
    consumer: RabbitMQConsumerOptions,
    callback: IRabbitHandler,
  ) {
    const exchangeBindName = consumer.exchangeName.endsWith(
      consumer.suffixOptions?.exchangeSuffix ?? ".exchange",
    )
      ? consumer.exchangeName
      : `${consumer.exchangeName}${consumer.suffixOptions?.exchangeSuffix ?? ".exchange"}`;

    return this.connection.createChannel({
      confirm: true,
      name: consumer.queue,
      setup: (channel: ConfirmChannel) => {
        return Promise.all([
          channel.prefetch(consumer.prefetch ?? 10),
          channel.assertQueue(consumer.queue, {
            durable: consumer.durable ?? true,
            autoDelete: consumer.autoDelete ?? false,
            deadLetterRoutingKey: `${consumer.queue}${consumer.suffixOptions?.dlqSuffix ?? ".dlq"}`,
            deadLetterExchange: "",
          }),

          channel.bindQueue(
            consumer.queue,
            exchangeBindName,
            consumer.routingKey,
          ),

          this.attachRetryAndDLQ(channel, consumer),

          channel.consume(consumer.queue, async (message) => {
            await this.processConsumer(message, channel, consumer, callback);
          }),
        ]);
      },
    });
  }

  private async processConsumer(
    message: ConsumeMessage,
    channel: ConfirmChannel,
    consumer: RabbitMQConsumerOptions,
    callback: IRabbitHandler,
  ) {
    let hasErrors = null;

    try {
      await callback(RabbitMQService.parse(message), {
        message,
        channel,
        queue: consumer.queue,
      });

      if (consumer.autoAck === undefined || consumer.autoAck) {
        channel.ack(message);
      }
    } catch (e) {
      hasErrors = e;
      await this.processRetry(consumer, message, channel);
    } finally {
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
  ) {
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
  ) {
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
          const isPublished = await this.publish(
            this.delayExchange,
            consumer.queue,
            RabbitMQService.parse(message),
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
          console.log(JSON.stringify({ message: "could_not_retry", error: e }));
          channel.nack(message);
        }
      }
    }

    channel.nack(message, false, false);
  }

  private inspectConsumer(args: InspectInput): void {
    if (!["consumer", "all"].includes(this.logType) && args?.error == undefined)
      return;

    const { binding, consumeMessage, data, error } = args;

    const { exchange, routingKey, queue } = binding;
    const { content, fields, properties } = consumeMessage;
    const message = `[AMQP] [CONSUMER] [${exchange}] [${routingKey}] [${queue}]`;
    const logLevel = error ? "error" : "info";

    const logData = {
      logLevel,
      correlationId: args?.consumeMessage?.properties?.correlationId,
      binding,
      title: message,
      message: {
        fields,
        properties,
        content: data ?? content.toString("utf8"),
      },
      error,
    };

    if (error)
      Object.assign(logData, { error: error.message ?? error.toString() });

    console[logLevel](JSON.stringify(logData));

    // this.logger[logLevel]({ message, amqp: logData });
  }

  private inspectPublisher(
    exchange: string,
    routingKey: string,
    content: any,
    properties?: PublishOptions,
    error?: any,
  ): void {
    if (!["publisher", "all"].includes(this.logType) && !error) return;

    const logLevel = error ? "error" : "info";
    const message = `[AMQP] [PUBLISH] [${exchange}] [${routingKey}]`;
    const logData = {
      logLevel,
      correlationId: properties?.correlationId,
      title: message,
      binding: { exchange, routingKey },
      message: { content, properties },
    };

    if (error)
      Object.assign(logData, { error: error.message ?? error.toString() });

    console[logLevel](JSON.stringify(logData));

    // this.logger[logLevel]({
    //   log
    //   message,
    //   amqp: logData,
    //   error,
    // });
  }
}
