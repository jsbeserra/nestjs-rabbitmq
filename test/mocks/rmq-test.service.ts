import { Injectable } from "@nestjs/common";
import {
  IRabbitConsumer,
  RabbitConsumerParameters,
  RabbitMQService,
} from "../../";

@Injectable()
export class RmqTestService implements IRabbitConsumer {
  constructor(readonly rabbitService: RabbitMQService) {}

  messageHandler(
    content: any,
    parameters?: RabbitConsumerParameters,
  ): Promise<void> {
    return null;
  }

  testHandler2(content: any) {
    return null;
  }
}
