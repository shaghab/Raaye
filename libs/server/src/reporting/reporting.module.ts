import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { ReportingService } from './reporting.service';
import { SharingService } from './sharing.service';

@Module({
  providers: [ReportingService, ExportService, SharingService],
  exports: [ReportingService, ExportService, SharingService],
})
export class ReportingModule {}
