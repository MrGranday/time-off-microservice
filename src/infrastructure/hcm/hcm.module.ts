import { Module } from '@nestjs/common';
import { HcmAdapter } from './hcm.adapter';

@Module({
  providers: [HcmAdapter],
  exports: [HcmAdapter],
})
export class HcmModule {}
