// #region project-access-controller
import { Body, Controller, Param, Put } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import type { MinLength } from '@exprtlabs/golem/tags';
import { ProjectAccess } from './project-access.model.js';

@Controller('projects/:projectId/access')
export class ProjectAccessController {
  @Put()
  @ApiOperation({ operationId: 'updateProjectAccess' })
  public putProjectAccess(
    @Param('projectId') _projectId: string & MinLength<1>,
    @Body() input: ProjectAccess,
  ): ProjectAccess {
    return input;
  }
}
// #endregion project-access-controller
