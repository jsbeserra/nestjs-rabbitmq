import { DynamicModule, Module, Type } from "@nestjs/common";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { RabbitOptionsFactory } from "./rabbitmq-options.interface";
import { RabbitMQService } from "./rabbitmq-service";

export type RabbitOptions = {
  useClass: Type<RabbitOptionsFactory>;
  imports?: any[];
};

@Module({})
export class RabbitMQModule {
  static register(options: RabbitOptions): DynamicModule {
    // const rabbitPublisherProvider = {
    //   provide: RabbitMQService,
    //   useValue: singletonPublihser,
    // };

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
        // rabbitPublisherProvider,
        RabbitMQService,
      ],
      exports: [RabbitMQService],
    };
  }
}
