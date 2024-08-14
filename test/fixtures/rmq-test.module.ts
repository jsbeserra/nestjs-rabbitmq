import { Module } from "@nestjs/common";
import { RmqTestService } from "./rmq-test.service";

@Module({
  providers: [RmqTestService],
  exports: [RmqTestService],
})
export class RmqTestModule {}
