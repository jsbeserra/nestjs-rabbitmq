import { DynamicModule, Module, Type } from "@nestjs/common";
import { RabbitMQService } from "./rabbitmq.service";
import { RabbitOptionsFactory } from "./rabbitmq-options.interface";

export type RabbitOptions = {
  useClass: Type<RabbitOptionsFactory>;
  imports?: any[];
};

@Module({})
export class RabbitMQModule {
  static register(options: RabbitOptions): DynamicModule {
    const importable = options.imports ?? [];

    return {
      module: RabbitMQModule,
      imports: [...importable],
      global: true,
      providers: [
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
