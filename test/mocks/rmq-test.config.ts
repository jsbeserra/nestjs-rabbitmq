import { Injectable } from "@nestjs/common";
import {
  RabbitMQAssertExchange,
  RabbitMQConsumerOptions,
  RabbitMQModuleOptions,
  RabbitOptionsFactory,
} from "../../";
import { RmqTestService } from "./rmq-test.service";

export const TestExchanges: RabbitMQAssertExchange[] = [
  { name: "test_direct", type: "direct" },
  { name: "test", type: "topic", options: { exchangeSufix: "test" } },
  { name: "test_fanout", type: "fanout", options: { isDelayed: true } },
];

export const TestConsumers: RabbitMQConsumerOptions[] = [
  {
    queue: "test_direct_queue",
    exchangeName: "test_direct.exchange",
    routingKey: "test_direct_queue",
    prefetch: 1,
  },
];

@Injectable()
export class RmqTestConfig implements RabbitOptionsFactory {
  constructor(private readonly rmqTest: RmqTestService) {}

  createRabbitOptions(): RabbitMQModuleOptions {
    return {
      connectionString: "amqp://localhost:5672",
      delayExchangeName: "test_delay",
      assertExchanges: TestExchanges,
      consumerChannels: [
        {
          options: {
            ...TestConsumers[0],
          },
          messageHandler: this.rmqTest.messageHandler.bind(this.rmqTest),
        },
        {
          options: {
            ...TestConsumers[1],
          },
          messageHandler: this.rmqTest.testHandler2.bind(this.rmqTest),
        },
      ],
    };
  }
}
