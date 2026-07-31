import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  CollaborationGraphService,
  type CollaborationGraph,
} from './collaboration-graph.service';
import { GraphQueryDto } from './dto/graph-query.dto';

@ApiTags('Admin – Collaboration graph')
@Controller('admin/collaboration-graph')
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.MODERATOR)
@ApiBearerAuth()
@ApiCookieAuth()
export class CollaborationGraphController {
  constructor(private readonly graphService: CollaborationGraphService) {}

  @Get()
  @ApiOperation({
    summary: 'Employer↔worker collaboration network (admin only)',
    description:
      'Nodes are profiles, links are shared job offers. A link carries two counts: missions actually worked together (Assignment) and applications that never became one.',
  })
  @ApiResponse({ status: 200, description: 'Graph nodes and links' })
  async getGraph(@Query() query: GraphQueryDto): Promise<CollaborationGraph> {
    return this.graphService.getGraph(query);
  }
}
