import { Module } from '@nestjs/common';
import { ConsentService } from './consent.service';
import { ContactsService } from './contacts.service';
import { GroupsTagsService } from './groups-tags.service';
import { ImportService } from './import.service';

@Module({
  providers: [ConsentService, ContactsService, GroupsTagsService, ImportService],
  exports: [ConsentService, ContactsService, GroupsTagsService, ImportService],
})
export class ContactsModule {}
