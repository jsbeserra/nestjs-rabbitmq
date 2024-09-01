import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { PublishOptions } from "./rabbitmq.types";
import { RabbitMQConsumer } from "./rabbitmq-consumers";
import { ChannelWrapper } from "amqp-connection-manager";

export class RabbitMQService {
  private logger: Console | Logger =
    AMQPConnectionManager.rabbitModuleOptions?.extraOptions?.loggerInstance ??
    new Logger(RabbitMQService.name);

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
      await AMQPConnectionManager.publishChannelWrapper.publish(
        exchangeName,
        routingKey,
        JSON.stringify(message),
        {
          correlationId: randomUUID(),
          ...options,
        },
      );
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

  async createConsumers(): Promise<ChannelWrapper[]> {
    if (AMQPConnectionManager.isConsumersLoaded)
      throw new Error(
        "Consumers already initialized. If you wish to start it manually, see consumeManualLoad",
      );

    const consumerOptionList =
      AMQPConnectionManager.rabbitModuleOptions.consumerChannels ?? [];

    const consumerList = [];

    for (const consumerEntry of consumerOptionList) {
      const consumerOptions = consumerEntry.options;

      const consumer = await new RabbitMQConsumer(
        AMQPConnectionManager.connection,
        AMQPConnectionManager.rabbitModuleOptions,
        AMQPConnectionManager.publishChannelWrapper,
      ).createConsumer(consumerOptions, consumerEntry.messageHandler);

      consumerList.push(consumer);
    }

    this.logger.debug("Initiating RabbitMQ consumers manually");
    AMQPConnectionManager.isConsumersLoaded = true;
    return consumerList;
  }

  private inspectPublisher(
    exchange: string,
    routingKey: string,
    content: any,
    properties?: PublishOptions,
    error?: any,
  ): void {
    if (
      !["publisher", "all"].includes(
        AMQPConnectionManager.rabbitModuleOptions.extraOptions.logType,
      ) &&
      !error
    )
      return;

    const logLevel = error ? "error" : "log";
    const logData = {
      logLevel,
      correlationId: properties?.correlationId,
      title: `[AMQP] [PUBLISH] [${exchange}] [${routingKey}]`,
      binding: { exchange, routingKey },
      message: { content, properties },
    };

    if (error) {
      Object.assign(logData, { error: error.message ?? error.toString() });
    }

    this.logger[logLevel](JSON.stringify(logData));
  }
}
