import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { EstimatePage } from './estimate.page';

const routes: Routes = [
  {
    path: '',
    component: EstimatePage,
  },
  {
    path: ':jobId',
    component: EstimatePage,
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class EstimatePageRoutingModule {}