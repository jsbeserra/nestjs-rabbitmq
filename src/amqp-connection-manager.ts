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
  private readonly logger: Logger = new Logger(AMQPConnectionManager.name);
  private rabbitTerminalErrors: string[] = [
    "channel-error",
    "precondition-failed",
    "not-allowed",
    "access-refused",
    "closed via management plugin",
  ];
  public static rabbitModuleOptions: RabbitMQModuleOptions;
  public static publishChannelWrapper: ChannelWrapper = null;
  public static connection: AmqpConnectionManager;
  public static isConsumersLoaded: boolean = false;

  constructor(@Inject("RABBIT_OPTIONS") options: RabbitOptionsFactory) {
    AMQPConnectionManager.rabbitModuleOptions = options.createRabbitOptions();
  }

  async onModuleInit() {
    if (process.env.NODE_ENV != "test") {
      return this.connect();
    }
  }

  async onApplicationBootstrap() {
    if (AMQPConnectionManager.rabbitModuleOptions?.consumerManualLoad == true)
      return;

    const consumerInstance = new RabbitMQConsumer(
      this.getConnection(),
      AMQPConnectionManager.rabbitModuleOptions,
      AMQPConnectionManager.publishChannelWrapper,
    );

    await consumerInstance.createConsumers();
    this.logger.debug("Initiating RabbitMQ consumers automatically");
  }

  async onApplicationShutdown() {
    this.logger.log("Closing RabbitMQ Connection");
    await AMQPConnectionManager?.connection?.close();
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

  private attachEvents(resolve) {
    if (AMQPConnectionManager.rabbitModuleOptions?.waitConnection === false)
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
        for (const publisher of AMQPConnectionManager.rabbitModuleOptions
          ?.assertExchanges ?? []) {
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
}
