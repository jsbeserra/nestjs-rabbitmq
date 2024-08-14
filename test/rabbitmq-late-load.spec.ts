import { TestingModule, Test } from "@nestjs/testing";
import { RabbitMQService, RabbitMQModule } from "../src";
import { AMQPConnectionManager } from "../src/amqp-connection-manager";
import { RmqTestManualConsumerConfig } from "./mocks/configs/rmq-test-manual-consumer.config";
import { RmqTestModule } from "./mocks/rmq-test.module";
import { RabbitMQConsumer } from "../src/rabbitmq-consumers";
import { TestConsumers } from "./mocks/configs/rmq-test.config";

describe("AMQPConnectionManager Late Loading", () => {
  let rabbitMqService: RabbitMQService;
  let moduleRef: TestingModule;
  let createConsumersSpy: jest.SpyInstance<any, unknown[], any>;

  beforeAll(async () => {
    createConsumersSpy = jest.spyOn(
      AMQPConnectionManager.prototype as any,
      "createConsumers",
    );

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

    await AMQPConnectionManager.publishChannelWrapper.waitForConnect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it("should not call createConsumers", () => {
    expect(createConsumersSpy).toHaveBeenCalledTimes(0);
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
});
