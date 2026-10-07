import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { SimulatorService } from './simulator.service';

@Module({
  imports: [ConversationModule],
  providers: [SimulatorService],
  exports: [SimulatorService],
})
export class SimulatorModule {}
