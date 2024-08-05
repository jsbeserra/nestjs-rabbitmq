import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import {
  AmqpConnectionManager,
  ChannelWrapper,
  connect,
} from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import { hostname } from "node:os";
import {
  IRabbitHandler,
  LogType,
  RabbitMQConsumerOptions,
  RabbitMQModuleOptions,
  RabbitOptionsFactory,
} from "./rabbitmq-options.interface";
import { RabbitMQService } from "./rabbitmq-service";

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

export const AMQPPublisher = Inject("AMQP_PUBLISHER");

@Injectable()
export class AMQPConnectionManager
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger: Logger = new Logger(AMQPConnectionManager.name);
  private rabbitTerminalErrors = [
    "channel-error",
    "precondition-failed",
    "not-allowed",
    "access-refused",
    "closed via management plugin",
  ];
  private logType: LogType = "none";
  private rabbitModuleOptions: RabbitMQModuleOptions;
  public static publishChannelWrapper: ChannelWrapper = null;
  public static connection: AmqpConnectionManager;
  private delayExchange: string;
  private isConsumersLoaded = false;
  public static publisherInstance: RabbitMQService;

  constructor(@Inject("RABBIT_OPTIONS") options: RabbitOptionsFactory) {
    this.rabbitModuleOptions = options.createRabbitOptions();
  }

  async onModuleInit() {
    this.delayExchange = `${this.rabbitModuleOptions.delayExchangeName}.delay.exchange`;
    this.logType =
      (process.env.RABBITMQ_TRAFFIC_TYPE as LogType) ??
      this.rabbitModuleOptions.trafficInspection ??
      "none";

    if (process.env.NODE_ENV != "test") {
      return this.connect();
    }
  }

  async onApplicationBootstrap() {
    if (this.rabbitModuleOptions?.consumerManualLoad ?? false) {
      this.logger.log("Initiating RabbitMQ consumers automatically");
      // const x = new Consumers(connection, options);
      await this.createConsumer();
      this.isConsumersLoaded = true;
    }
  }

  async onApplicationShutdown() {
    this.logger.log("Closing RabbitMQ Connection");
    await AMQPConnectionManager?.connection?.close();
  }

  private async connect() {
    await new Promise((resolve) => {
      AMQPConnectionManager.connection = connect(
        this.rabbitModuleOptions.connectionString,
        {
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
        },
      );

      this.attachEvents(resolve);
    });

    await this.assertExchanges();
  }

  private attachEvents(resolve) {
    if (this.rabbitModuleOptions?.waitConnection === false) resolve(true);

    this.getConnection().on("connect", async ({ url }: { url: string }) => {
      this.logger.log(
        `Rabbit connected to ${url.replace(
          new RegExp(url.replace(/amqp:\/\/[^:]*:([^@]*)@.*?$/i, "$1"), "g"),
          "***",
        )}`,
      );
      resolve(true);
    });

    this.getConnection().on("disconnect", ({ err }) => {
      console.warn(`Disconnected from rabbitmq: ${err.message}`);

      if (
        this.rabbitTerminalErrors.some((errorMessage) =>
          err.message.toLowerCase().includes(errorMessage),
        )
      ) {
        this.getConnection().close();
        console.error(
          "RabbitMQ Disconnected with a terminal error, impossible to reconnect",
        );
      }
    });

    this.getConnection().on("connectFailed", ({ err }) => {
      console.error(`Failure to connect to RabbitMQ instance: ${err.message}`);
    });
  }

  private getConnection() {
    return AMQPConnectionManager.connection;
  }

  private async assertExchanges(): Promise<void> {
    this.logger.debug("Initiating RabbitMQ producers");

    AMQPConnectionManager.publishChannelWrapper =
      this.getConnection().createChannel({
        name: `${process.env.npm_package_name}_publish`,
        confirm: true,
        publishTimeout: 60000,
      });

    await AMQPConnectionManager.publishChannelWrapper.addSetup(
      async (channel: ConfirmChannel) => {
        for (const publisher of this.rabbitModuleOptions?.assertExchanges ??
          []) {
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

  private async createConsumer(): Promise<ChannelWrapper> {
    if (this.isConsumersLoaded) {
      throw new Error(
        "Consumers already initialized. If you want to initiate the consumers manually please set lateLoading: true",
      );
    }

    for (const consumerEntry of this.rabbitModuleOptions?.consumerChannels ??
      []) {
      const consumer = consumerEntry.options;

      const exchangeBindName = consumer.exchangeName.endsWith(
        consumer.suffixOptions?.exchangeSuffix ?? ".exchange",
      )
        ? consumer.exchangeName
        : `${consumer.exchangeName}${consumer.suffixOptions?.exchangeSuffix ?? ".exchange"}`;

      return this.getConnection().createChannel({
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
              await this.processConsumerMessage(
                message,
                channel,
                consumer,
                consumerEntry.messageHandler,
              );
            }),
          ]);
        },
      });
    }
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
          const isPublished =
            await AMQPConnectionManager.publishChannelWrapper.publish(
              this.delayExchange,
              consumer.queue,
              JSON.parse(message.content.toString("utf8")),
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
}
