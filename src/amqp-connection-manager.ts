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
import { ConfirmChannel } from "amqplib";
import { hostname } from "node:os";
import { RabbitMQModuleOptions } from "./rabbitmq.types";
import { RabbitMQConsumer } from "./rabbitmq-consumers";
import { RabbitOptionsFactory } from "./rabbitmq.interfaces";

@Injectable()
export class AMQPConnectionManager
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  // private readonly logger: Logger = new Logger(AMQPConnectionManager.name);
  private readonly logger: Console | Logger;
  private rabbitTerminalErrors: string[] = [
    "channel-error",
    "precondition-failed",
    "not-allowed",
    "access-refused",
    "closed via management plugin",
  ];

  private defaultOptions: Partial<RabbitMQModuleOptions> = {
    extraOptions: {
      connectionType: "sync",
      logType: "none",
      consumerManualLoad: false,
    },
  };
  public static rabbitModuleOptions: RabbitMQModuleOptions;
  public static publishChannelWrapper: ChannelWrapper = null;
  public static connection: AmqpConnectionManager;
  public static isConsumersLoaded: boolean = false;
  private consumers: ChannelWrapper[] = [];
  private connectionBlockedReason: string;

  constructor(@Inject("RABBIT_OPTIONS") options: RabbitOptionsFactory) {
    this.logger =
      options.createRabbitOptions()?.extraOptions?.loggerInstance ??
      new Logger(AMQPConnectionManager.name);
    AMQPConnectionManager.rabbitModuleOptions = {
      ...this.defaultOptions,
      ...options.createRabbitOptions(),
    };
  }

  async onModuleInit() {
    return this.connect();
  }

  async onApplicationBootstrap() {
    if (
      AMQPConnectionManager.rabbitModuleOptions.extraOptions.consumerManualLoad
    )
      return;
    await this.createConsumers();

    this.logger.debug("Initiating RabbitMQ consumers automatically");
  }

  async onApplicationShutdown() {
    this.logger.log("Closing RabbitMQ Connection");
    await AMQPConnectionManager?.connection?.close();
  }

  getConsumers() {
    return this.consumers;
  }

  private async connect() {
    await new Promise((resolve) => {
      AMQPConnectionManager.connection = connect(
        AMQPConnectionManager.rabbitModuleOptions.connectionString,
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

  private attachEvents(resolve: any) {
    if (
      AMQPConnectionManager.rabbitModuleOptions.extraOptions.connectionType ===
      "async"
    )
      resolve(true);

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
      this.logger.warn(`Disconnected from rabbitmq: ${err.message}`);

      if (
        this.rabbitTerminalErrors.some((errorMessage) =>
          err.message.toLowerCase().includes(errorMessage),
        )
      ) {
        this.getConnection().close();
        this.logger.error(
          "RabbitMQ Disconnected with a terminal error, impossible to reconnect",
        );
      }
    });

    this.getConnection().on("connectFailed", ({ err }) => {
      this.logger.error(
        `Failure to connect to RabbitMQ instance: ${err.message}`,
      );
    });

    this.getConnection().on("blocked", ({ reason }) => {
      this.logger.error(`RabbitMQ broker is blocked with reason: ${reason}`);
      this.connectionBlockedReason = reason;
    });

    this.getConnection().on("unblocked", () => {
      this.logger.error(
        `RabbitMQ broker connection is unblocked, last reason was: ${this.connectionBlockedReason}`,
      );
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
        for (const publisher of AMQPConnectionManager.rabbitModuleOptions
          ?.assertExchanges ?? []) {
          const isDelayed = publisher.options?.isDelayed ?? false;
          const type = isDelayed ? "x-delayed-message" : publisher.type;
          const argument = isDelayed
            ? { arguments: { "x-delayed-type": publisher.type } }
            : null;

          await channel.assertExchange(publisher.name, type, {
            durable: publisher?.options?.durable ?? true,
            autoDelete: publisher?.options?.autoDelete ?? false,
            ...argument,
          });
        }
      },
    );
  }

  private async createConsumers(): Promise<void> {
    const consumerList =
      AMQPConnectionManager.rabbitModuleOptions.consumerChannels ?? [];

    for (const consumerEntry of consumerList) {
      const consumer = consumerEntry.options;

      this.consumers.push(
        await new RabbitMQConsumer(
          AMQPConnectionManager.connection,
          AMQPConnectionManager.rabbitModuleOptions,
          AMQPConnectionManager.publishChannelWrapper,
        ).createConsumer(consumer, consumerEntry.messageHandler),
      );
    }

    AMQPConnectionManager.isConsumersLoaded = true;
  }
}
