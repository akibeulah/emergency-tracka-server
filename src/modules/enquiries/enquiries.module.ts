import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminEnquiriesController, EnquiriesController } from './enquiries.controller';
import { EnquiriesService } from './enquiries.service';
import { Enquiry, EnquirySchema } from './schemas/enquiry.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: Enquiry.name, schema: EnquirySchema }])],
  controllers: [EnquiriesController, AdminEnquiriesController],
  providers: [EnquiriesService],
})
export class EnquiriesModule {}
