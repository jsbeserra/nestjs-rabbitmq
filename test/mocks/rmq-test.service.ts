import { Injectable, Logger } from "@nestjs/common";
import { IRabbitConsumer, RabbitMQService } from "../../src";

@Injectable()
export class RmqTestService implements IRabbitConsumer {
  private logger = new Logger(RmqTestService.name);
  constructor(readonly rabbitService: RabbitMQService) {}

  async messageHandler(content: any): Promise<void> {
    console.log("Here is the message", content);
  }

  async throwHandler(content: any) {
    throw new Error("throw_test");
  }
}
