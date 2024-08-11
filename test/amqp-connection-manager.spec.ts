import { Test, TestingModule } from "@nestjs/testing";
import {
  RmqTestConfig,
  TestConsumers,
  TestExchanges,
} from "./mocks/configs/rmq-test.config";
import { RmqTestModule } from "./mocks/rmq-test.module";
import { RabbitMQModule } from "../src/rabbitmq.module";
import { RmqTestService } from "./mocks/rmq-test.service";
import { RabbitMQService } from "../src/rabbitmq-service";
import { AMQPConnectionManager } from "../src/amqp-connection-manager";
import { once } from "events";

describe("RabbitMQModule", () => {
  let rabbitMqService: RabbitMQService;
  let amqpManager: AMQPConnectionManager;
  let testService: RmqTestService;
  let moduleRef: TestingModule;
  let publishSpy;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        RmqTestModule,
        RabbitMQModule.register({
          useClass: RmqTestConfig,
          injects: [RmqTestModule],
        }),
      ],
    }).compile();

    moduleRef = await moduleRef.init();

    amqpManager = moduleRef.get(AMQPConnectionManager);
    rabbitMqService = moduleRef.get(RabbitMQService);
    testService = moduleRef.get(RmqTestService);

    await AMQPConnectionManager.publishChannelWrapper.waitForConnect();

    for (const consumer of amqpManager.getConsumers()) {
      await consumer.waitForConnect();
    }

    publishSpy = jest
      .spyOn(RabbitMQService.prototype, "publish")
      .mockImplementation(async () => {
        return true;
      });
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it("should return a truthy connection health", async () => {
    expect(testService.rabbitService.checkHealth()).toBeTruthy();
  });

  it("should completely stop the connection if error is terminal", async () => {
    // expect(spyEvents).toHaveBeenCalled();
  });

  describe("Publisher", () => {
    it("should have publisher channel connected", async () => {
      expect(AMQPConnectionManager.publishChannelWrapper).toBeDefined();
      expect(
        once(AMQPConnectionManager.publishChannelWrapper, "connect"),
      ).resolves.toBeDefined();
    });

    it("should have all declared exchanges created", async () => {
      for (const exchange of TestExchanges) {
        expect(
          await AMQPConnectionManager.publishChannelWrapper.checkExchange(
            exchange.name,
          ),
        ).toBeDefined();
      }
    });

    it("should publish a message to a declared exchange", async () => {
      const isPublished = await rabbitMqService.publish(
        TestConsumers[0].exchangeName,
        TestConsumers[0].routingKey,
        {},
      );

      expect(publishSpy).toHaveBeenCalled();
      expect(isPublished).toBeTruthy();
      jest.restoreAllMocks();
    });
  });

  describe("Consumer", () => {
    it("should have one channel for each consumer", async () => {
      expect(amqpManager.getConsumers().length).toEqual(TestConsumers.length);

      // Remove 1 channel because it is the publisher
      expect(AMQPConnectionManager.connection.channelCount - 1).toEqual(
        TestConsumers.length,
      );
    });

    it("should have all declared consumer queues created", async () => {
      for (const queue of TestConsumers) {
        expect(
          await AMQPConnectionManager.publishChannelWrapper.checkQueue(
            queue.queue,
          ),
        ).toBeDefined();
      }
    });
  });
});
