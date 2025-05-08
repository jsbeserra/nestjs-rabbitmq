import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit,
  Param,
} from "@nestjs/common";
import {
  AmqpConnectionManager,
  ChannelWrapper,
  connect,
} from "amqp-connection-manager";
import { hostname } from "node:os";
import { RabbitMQConsumer } from "./rabbitmq-consumers";
import { RabbitOptionsFactory } from "./rabbitmq.interfaces";
import {
  ConnectionType,
  RabbitMQConsumerChannel,
  RabbitMQModuleOptions,
} from "./rabbitmq.types";
import { merge } from "./helper";
import ExchangeManager from "./exchange-manager";
import ConsumerManager from "./consumers-manager";

@Injectable()
export class AMQPConnectionManager
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
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
      logType: "none",
      consumerManualLoad: false,
      heartbeatIntervalInSeconds: 0,
      reconnectTimeInSeconds: 5,
    },
  };
  public static rabbitModuleOptions: RabbitMQModuleOptions;
  public static publishChannelWrapper: ChannelWrapper = null;
  public static consumerConn: AmqpConnectionManager;
  public static publisherConn: AmqpConnectionManager;
  public static isConsumersLoaded: boolean = false;
  private connectionBlockedReason: string;
  private consumers: ChannelWrapper[] = [];
  private exchangeManager: ExchangeManager;
  private consumerManager: ConsumerManager;

  constructor(@Inject("RABBIT_OPTIONS") options: RabbitOptionsFactory) {
    AMQPConnectionManager.rabbitModuleOptions = merge(
      this.defaultOptions,
      options.createRabbitOptions(),
    );

    this.logger =
      AMQPConnectionManager.rabbitModuleOptions.extraOptions?.loggerInstance ??
      new Logger(AMQPConnectionManager.name);
  }

  async onModuleInit() {
    return this.connect();
  }

  async onApplicationBootstrap() {
    if (
      AMQPConnectionManager.rabbitModuleOptions.extraOptions.consumerManualLoad
    )
      return;
    this.consumerManager = new ConsumerManager(
      this.consumers,
      AMQPConnectionManager.consumerConn,
      AMQPConnectionManager.rabbitModuleOptions,
      AMQPConnectionManager.publishChannelWrapper,
      this.logger,
    );
    AMQPConnectionManager.isConsumersLoaded =
      await this.consumerManager.createConsumers(
        AMQPConnectionManager.rabbitModuleOptions.consumerChannels,
      );

    this.logger.debug("Initiating RabbitMQ consumers automatically");
  }

  async onApplicationShutdown() {
    this.logger.log("Closing RabbitMQ Connection");
    await AMQPConnectionManager?.consumerConn?.close();
    await AMQPConnectionManager?.publisherConn?.close();
  }

  public getConsumers() {
    return this.consumers;
  }

  private async connect() {
    const params = {
      heartbeatIntervalInSeconds:
        AMQPConnectionManager.rabbitModuleOptions.extraOptions
          .heartbeatIntervalInSeconds,
      reconnectTimeInSeconds:
        AMQPConnectionManager.rabbitModuleOptions.extraOptions
          .reconnectTimeInSeconds,
      connectionOptions: {
        keepAlive: true,
        keepAliveDelay: 5000,
        servername: hostname(),
        clientProperties: {
          connection_name: `${process.env?.npm_package_name ?? process.env.SERVICE_NAME}-${hostname()}-consumer`,
        },
      },
    };

    await new Promise((resolve) => {
      AMQPConnectionManager.consumerConn = this.createConnection(
        params,
        "consumer",
      );
      this.attachEvents("consumer", resolve);
    });

    await new Promise((resolve) => {
      AMQPConnectionManager.publisherConn = this.createConnection(
        params,
        "publisher",
      );
      this.attachEvents("publisher", resolve);
    });

    this.exchangeManager = new ExchangeManager(
      this.getConnection("publisher"),
      this.logger,
    );
    AMQPConnectionManager.publishChannelWrapper =
      await this.exchangeManager.createPublishChannel();

    await this.exchangeManager.assert(
      AMQPConnectionManager.rabbitModuleOptions?.assertExchanges ?? [],
    );
  }

  private createConnection(
    params: any,
    type: "publisher" | "consumer",
  ): AmqpConnectionManager {
    return connect(AMQPConnectionManager.rabbitModuleOptions.connectionString, {
      ...params,
      connectionOptions: {
        clientProperties: {
          connection_name: `${process.env?.npm_package_name ?? process.env.SERVICE_NAME}-${hostname()}-${type}`,
        },
      },
    });
  }

  private attachEvents(type: ConnectionType, resolve: any) {
    const conn = this.getConnection(type);

    conn.on("connect", async ({ url }: { url: string }) => {
      this.logger.log(
        `Rabbit ${type} connected to ${url.replace(
          new RegExp(url.replace(/amqp:\/\/[^:]*:([^@]*)@.*?$/i, "$1"), "g"),
          "***",
        )}`,
      );
      resolve(true);
    });

    conn.on("disconnect", ({ err }) => {
      this.logger.warn(`Disconnected from rabbitmq: ${err.message}`);

      if (
        this.rabbitTerminalErrors.some((errorMessage) =>
          err.message.toLowerCase().includes(errorMessage),
        )
      ) {
        conn.close();

        this.logger.error({
          message: `RabbitMQ Disconnected with a terminal error, impossible to reconnect `,
          error: err,
          x: err.message,
        });
      }
    });

    conn.on("connectFailed", ({ err }) => {
      this.logger.error(
        `Failure to connect to RabbitMQ instance: ${err.message}`,
      );
    });

    if (type === "publisher") {
      conn.on("blocked", ({ reason }) => {
        this.logger.error(`RabbitMQ broker is blocked with reason: ${reason}`);
        this.connectionBlockedReason = reason;
      });

      conn.on("unblocked", () => {
        this.logger.error(
          `RabbitMQ broker connection is unblocked, last reason was: ${this.connectionBlockedReason}`,
        );
      });
    }
  }

  public getConnection(type: ConnectionType) {
    if (type === "publisher") {
      return AMQPConnectionManager.publisherConn;
    }
    return AMQPConnectionManager.consumerConn;
  }
}
