import { Logger, OnApplicationBootstrap } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { PublishOptions } from "./rabbitmq.types";
import { RabbitMQConsumer } from "./rabbitmq-consumers";

export class RabbitMQService implements OnApplicationBootstrap {
  private logger = new Logger(RabbitMQService.name);

  private connectionBlocked: { isBlocked: boolean; reason: string } = {
    isBlocked: false,
    reason: "",
  };

  async onApplicationBootstrap() {
    AMQPConnectionManager.connection.on("blocked", ({ reason }) => {
      console.error(`RabbitMQ broker is blocked with reason: ${reason}`);
      this.connectionBlocked = { isBlocked: true, reason };
    });

    AMQPConnectionManager.connection.on("unblocked", () => {
      console.error(
        `RabbitMQ broker connection is unblocked, last reason was: ${this.connectionBlocked?.reason}`,
      );
      this.connectionBlocked = { isBlocked: false, reason: "" };
    });
  }

  /**
   * Check status of the main conenection to the broker.
   * @returns {number} 1 - Online | 0 - Offline
   */
  public checkHealth(): number {
    return AMQPConnectionManager.connection.isConnected() ? 1 : 0;
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
  async publish<T = any>(
    exchangeName: string,
    routingKey: string,
    message: T,
    options?: PublishOptions,
  ): Promise<boolean> {
    let hasErrors = null;

    try {
      if (AMQPConnectionManager.connection) {
        await this.waitForBlockedConnection();
        return AMQPConnectionManager.publishChannelWrapper.publish(
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

  async createConsumers() {
    if (AMQPConnectionManager.isConsumersLoaded) {
      throw new Error(
        "Consumers already initialized. If you want to initiate the consumers manually please set consumerManualLoad: true",
      );
    }

    const consumerInstance = new RabbitMQConsumer(
      AMQPConnectionManager.connection,
      AMQPConnectionManager.rabbitModuleOptions,
      AMQPConnectionManager.publishChannelWrapper,
    );
    await consumerInstance.createConsumers();
    this.logger.debug("Initiating RabbitMQ consumers manually");
  }

  private async waitForBlockedConnection(): Promise<void> {
    let retry = 0;

    while (this.connectionBlocked.isBlocked && retry <= 60) {
      console.warn(
        "RabbitMQ connection is blocked, waiting 1s before trying again",
      );
      retry++;

      await new Promise<void>((resolve) =>
        setTimeout(() => {
          resolve();
        }, 1000),
      );
    }

    if (retry >= 60) {
      throw new Error(
        `RabbitMQ connection is still blocked, cannot publish message. Reason: ${this.connectionBlocked?.reason}`,
      );
    }
  }

  private inspectPublisher(
    exchange: string,
    routingKey: string,
    content: any,
    properties?: PublishOptions,
    error?: any,
  ): void {
    // if (
    //   !["publisher", "all"].includes(
    //     this.rabbitModuleOptions.trafficInspection,
    //   ) &&
    //   !error
    // )
    //   return;

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
