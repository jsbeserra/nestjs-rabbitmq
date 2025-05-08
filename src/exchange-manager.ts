import { Injectable, Logger } from "@nestjs/common";
import { AmqpConnectionManager, ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel } from "amqplib";
import { RabbitMQAssertExchange } from "./rabbitmq.types";


export default class ExchangeManager {
  private publishChannel: ChannelWrapper;
  constructor(
    readonly connection: AmqpConnectionManager,
    readonly logger: Console | Logger,
  ) {}

  public async createPublishChannel(): Promise<ChannelWrapper> {
    await new Promise((resolve) => {
      this.publishChannel = this.connection.createChannel({
        name: `${process.env.npm_package_name}_publish`,
        confirm: true,
        publishTimeout: 60000,
      });

      this.publishChannel.on("connect", () => {
        this.logger.debug("Initiating RabbitMQ producers");
        resolve(true);
      });

      this.publishChannel.on("close", () => {
        this.logger.debug("Closing RabbitMQ producer channel");
      });

      this.publishChannel.on("error", (err, info) => {
        this.logger.error("Cannot open publish channel", err, info);
      });
    });
    return this.publishChannel;
  }

  public async assert(exchanges: RabbitMQAssertExchange[]): Promise<void> {
    for (const publisher of exchanges ?? []) {
      await this.publishChannel.addSetup(async (channel: ConfirmChannel) => {
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
      });
    }
  }
}
