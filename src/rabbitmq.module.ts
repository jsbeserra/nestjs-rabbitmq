import { DynamicModule, Module, Type } from "@nestjs/common";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { RabbitMQService } from "./rabbitmq-service";
import { RabbitOptionsFactory } from "./rabbitmq.interfaces";

export type RabbitOptions = {
  useClass: Type<RabbitOptionsFactory>;
  imports?: any[];
};

@Module({})
export class RabbitMQModule {
  static register(options: RabbitOptions): DynamicModule {
    return {
      module: RabbitMQModule,
      imports: [...(options?.imports ?? [])],
      global: true,
      providers: [
        AMQPConnectionManager,
        {
          provide: "RABBIT_OPTIONS",
          useClass: options.useClass,
        },
        RabbitMQService,
      ],
      exports: [RabbitMQService],
    };
  }
}
