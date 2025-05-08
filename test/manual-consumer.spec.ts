import { TestingModule, Test } from "@nestjs/testing";
import { RabbitMQService, RabbitMQModule } from "../src";
import { AMQPConnectionManager } from "../src/manager/amqp-connection-manager";
import { RmqTestManualConsumerConfig } from "./fixtures/configs/rmq-test-manual-consumer.config";
import { RmqTestModule } from "./fixtures/rmq-test.module";
import { RabbitMQConsumer } from "../src/rabbitmq-consumers";
import { TestConsumers } from "./fixtures/configs/rmq-test.config";
import { Logger } from "@nestjs/common";
import { RmqTestService } from "./fixtures/rmq-test.service";

describe("AMQPConnectionManager Late Loading", () => {
  let rabbitMqService: RabbitMQService;
  let moduleRef: TestingModule;
  let amqpConnectionManager: AMQPConnectionManager;
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        RmqTestModule,
        RabbitMQModule.register({
          useClass: RmqTestManualConsumerConfig,
          injects: [RmqTestModule],
        }),
      ],
    }).compile();

    moduleRef = await moduleRef.init();
    moduleRef.useLogger(false);
    rabbitMqService = moduleRef.get(RabbitMQService);
    amqpConnectionManager = moduleRef.get(AMQPConnectionManager);

    await AMQPConnectionManager.publishChannelWrapper.waitForConnect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it("should not call createConsumers", () => {
    expect(amqpConnectionManager.getConsumers().length).toBe(0);
  });

  it("should begin consumers manually", async () => {
    const consumerSpy = jest.spyOn(
      RabbitMQService.prototype,
      "createConsumers",
    );

    const createSpy = jest.spyOn(RabbitMQConsumer.prototype, "createConsumer");
    const consumers = await rabbitMqService.createConsumers();
    await consumers[0].waitForConnect();

    expect(consumerSpy).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toMatchObject(TestConsumers[0]);
  });

  it("should publish and not log message", async () => {
    jest.clearAllMocks();

    const spy = jest.spyOn(RabbitMQService.prototype, "publish");
    const loggerSpy = jest.spyOn(Logger.prototype, "log");
    jest
      .spyOn(RmqTestService.prototype, "messageHandler")
      .mockImplementation(async () => { });

    const isPublished = await rabbitMqService.publish(
      TestConsumers[0].exchangeName,
      TestConsumers[0].routingKey as string,
      { test: "published" },
    );

    expect(spy).toHaveBeenCalled();
    expect(isPublished).toBeTruthy();

    expect(loggerSpy).not.toHaveBeenCalled();
  });
});
