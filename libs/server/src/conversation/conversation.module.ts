import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { AnswerService } from './answer.service';
import { ConversationService } from './conversation.service';
import { InboxService } from './inbox.service';
import { ResultsAccessService } from './results-access.service';

@Module({
  imports: [ContactsModule],
  providers: [InboxService, AnswerService, ResultsAccessService, ConversationService],
  exports: [InboxService, AnswerService, ResultsAccessService, ConversationService],
})
export class ConversationModule {}
