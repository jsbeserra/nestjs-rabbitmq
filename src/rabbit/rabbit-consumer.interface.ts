import { RabbitConsumerParameters } from "./rabbitmq-options.interface";

export interface IRabbitConsumer<T = any> {
  messageHandler(
    content: T,
    parameters?: RabbitConsumerParameters,
  ): Promise<void>;
}
