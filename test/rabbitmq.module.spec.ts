import { Test } from "@nestjs/testing";
import { RmqTestConfig } from "./mocks/rmq-test.config";
import { RmqTestModule } from "./mocks/rmq-test.module";
import { RabbitMQModule } from "../src/rabbitmq.module";
import { RmqTestService } from "./mocks/rmq-test.service";
import { RabbitMQService } from "../src/rabbitmq-service";

describe("RabbitMQModule", () => {
  // let rabbitMqService: RabbitMQService;
  let testService: RmqTestService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        RmqTestModule,
        RabbitMQModule.register({
          useClass: RmqTestConfig,
          injects: [RmqTestModule],
        }),
      ],
      providers: [RmqTestService],
      exports: [RmqTestService],
    }).compile();

    // rabbitMqService = moduleRef.get(RabbitMQService);
    testService = moduleRef.get(RmqTestService);
  });

  it("Check health", async () => {
    expect(testService.rabbitService.checkHealth()).toBeTruthy();
  });
});
