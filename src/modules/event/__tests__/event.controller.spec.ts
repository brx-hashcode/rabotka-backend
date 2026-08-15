import { Test, TestingModule } from '@nestjs/testing';
import { EventController } from '../event.controller';
import { EventService } from '../event.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { LogService } from '../../log/log.service';
import { EventEditScope } from '../enums/event-edit-scope.enum';

const mockEventService = {
  list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10 }),
  findOne: jest.fn().mockResolvedValue({ id: 1, title: 'Test Event' }),
  create: jest.fn().mockResolvedValue({ id: 1, title: 'New Event' }),
  update: jest.fn().mockResolvedValue({ id: 1, title: 'Updated' }),
  remove: jest.fn().mockResolvedValue(undefined),
};

const fakeReq = (userId = 'user-1') =>
  ({
    user: { userId },
    headers: {},
    ip: '127.0.0.1',
    get: () => undefined,
  }) as any;

describe('EventController', () => {
  let controller: EventController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventController],
      providers: [
        { provide: EventService, useValue: mockEventService },
        { provide: LogService, useValue: { create: jest.fn() } },
      ],
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
    const result = await controller.create(fakeReq(), {
      title: 'New Event',
      description: 'Desc',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
      color: '#FF0000',
    });
    expect(result.title).toBe('New Event');
  });

  it('updates event', async () => {
    const result = await controller.update(fakeReq(), 1, { title: 'Updated' });
    expect(result.title).toBe('Updated');
  });

  it('removes event', async () => {
    const result = await controller.remove(fakeReq(), 1, {});
    expect(result).toEqual({ success: true });
  });

  it('defaults an unqualified delete to a single occurrence', async () => {
    // Every caller that predates recurrence sends no scope, and must keep
    // deleting exactly the row it named.
    await controller.remove(fakeReq(), 1, {});
    expect(mockEventService.remove).toHaveBeenCalledWith(1, undefined);
  });

  it('forwards the requested scope to the service', async () => {
    await controller.remove(fakeReq(), 1, { scope: EventEditScope.ALL });
    expect(mockEventService.remove).toHaveBeenCalledWith(
      1,
      EventEditScope.ALL,
    );
  });
});
