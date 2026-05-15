import { Test, TestingModule } from '@nestjs/testing';
import { EventController } from '../event.controller';
import { EventService } from '../event.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const mockEventService = {
  list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10 }),
  findOne: jest.fn().mockResolvedValue({ id: 1, title: 'Test Event' }),
  create: jest.fn().mockResolvedValue({ id: 1, title: 'New Event' }),
  update: jest.fn().mockResolvedValue({ id: 1, title: 'Updated' }),
  remove: jest.fn().mockResolvedValue(undefined),
};

describe('EventController', () => {
  let controller: EventController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventController],
      providers: [{ provide: EventService, useValue: mockEventService }],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EventController>(EventController);
  });

  it('lists events', async () => {
    const result = await controller.list({});
    expect(result.data).toEqual([]);
    expect(mockEventService.list).toHaveBeenCalled();
  });

  it('gets event by id', async () => {
    const result = await controller.getById(1);
    expect(result.id).toBe(1);
  });

  it('creates event', async () => {
    const req = { user: { userId: 'user-1' } };
    const result = await controller.create(req, {
      title: 'New Event',
      description: 'Desc',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
      color: '#FF0000',
    });
    expect(result.title).toBe('New Event');
  });

  it('updates event', async () => {
    const result = await controller.update(1, { title: 'Updated' });
    expect(result.title).toBe('Updated');
  });

  it('removes event', async () => {
    const result = await controller.remove(1);
    expect(result).toEqual({ success: true });
  });
});
