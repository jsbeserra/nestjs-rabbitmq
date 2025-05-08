import ChannelWrapper from "amqp-connection-manager/dist/types/ChannelWrapper";
import {
  RabbitMQConsumerChannel,
  RabbitMQModuleOptions,
} from "../rabbitmq.types";
import { RabbitMQConsumer } from "../rabbitmq-consumers";
import { AmqpConnectionManager } from "amqp-connection-manager";
import { Logger } from "@nestjs/common";


export default class ConsumerManager {
  constructor(
    private consumers: ChannelWrapper[],
    readonly consumerConn: AmqpConnectionManager,
    readonly options: RabbitMQModuleOptions,
    readonly publishChannel: ChannelWrapper,
    readonly logger: Console | Logger,
  ) {}

  public async createConsumers(
    consumerChannels: RabbitMQConsumerChannel[],
  ): Promise<boolean> {
    const consumerList = consumerChannels ?? [];

    this.checkDuplicatedQueues(consumerList);

    for (const consumerEntry of consumerList) {
      const consumer = consumerEntry.options;
      this.consumers.push(
        await new RabbitMQConsumer(
          this.consumerConn,
          this.options,
          this.publishChannel,
        ).createConsumer(consumer, consumerEntry.messageHandler),
      );
    }
    return true;
  }

  private checkDuplicatedQueues(consumerList: RabbitMQConsumerChannel[]): void {
    const queueNameList = [];
    consumerList.map((curr) => queueNameList.push(curr.options.queue));
    const dedupList = new Set(queueNameList);

    if (dedupList.size != queueNameList.length) {
      this.logger.error({
        error: "duplicated_queues",
        description: "Cannot have multiple queues on different binds",
        queues: Array.from(
          new Set(
            queueNameList.filter(
              (value, index) => queueNameList.indexOf(value) != index,
            ),
          ),
        ),
      });

      process.exit(-1);
    }
  }
}
