export { RabbitMQModule } from "./rabbit/rabbitmq.module";
export { RabbitMQService } from "./rabbit/rabbitmq-service";
export { ConfirmChannel, ConsumeMessage } from "amqplib";
export { IRabbitConsumer } from "./rabbit/rabbit-consumer.interface";
export {
  RabbitOptionsFactory,
  RabbitMQExchangeTypes,
  RabbitMQModuleOptions,
  RabbitMQAssertExchange,
  RabbitMQConsumerOptions as RabbitMQChannelOptions,
  RabbitConnectionOptions,
  RabbitMQConsumerChannel,
  PublishOptions,
  RabbitConsumerParameters,
} from "./rabbit/rabbitmq-options.interface";
