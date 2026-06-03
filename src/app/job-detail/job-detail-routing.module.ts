import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { JobDetailPage } from './job-detail.page';

const routes: Routes = [
  {
    path: '',
    component: JobDetailPage,
  },
  {
    path: ':jobId',
    component: JobDetailPage,
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class JobDetailPageRoutingModule {}
