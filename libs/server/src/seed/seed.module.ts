import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { JobsModule } from '../jobs/jobs.module';
import { ReportingModule } from '../reporting/reporting.module';
import { SimulatorModule } from '../simulator/simulator.module';
import { SurveysModule } from '../surveys/surveys.module';
import { SeedService } from './seed.service';

@Module({
  imports: [ContactsModule, SurveysModule, SimulatorModule, ReportingModule, JobsModule],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
