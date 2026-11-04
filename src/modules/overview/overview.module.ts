import { Controller, Get, Injectable, Module, UseGuards } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Alert, AlertDocument, AlertSchema } from '../admin/schemas/alert.schema';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { bedStatus, freshness } from '../capacity/capacity-status';
import { BedCategory, BedCategoryDocument, BedCategorySchema } from '../capacity/schemas/bed-category.schema';
import { Case, CaseDocument, CaseSchema } from '../cases/schemas/case.schema';
import { Offer, OfferDocument, OfferSchema } from '../cases/schemas/offer.schema';
import { Facility, FacilityDocument, FacilitySchema } from '../facilities/schemas/facility.schema';
import { Ambulance, AmbulanceDocument, AmbulanceSchema } from '../transport/schemas/ambulance.schema';
import { AmbulanceRequest, AmbulanceRequestDocument, AmbulanceRequestSchema } from '../transport/schemas/ambulance-request.schema';
import { lagosWeekStart } from '../users/roster';
import { DutyRoster, DutyRosterDocument, DutyRosterSchema } from '../users/schemas/duty-roster.schema';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';

const OPEN_OUTGOING = ['draft', 'sent', 'accepted', 'payment_pending', 'in_transit', 'arrived', 'declined', 'expired'];
const INBOUND = ['accepted', 'payment_pending', 'in_transit', 'arrived'];

/**
 * The facility console's overview: one read that answers "how are we right now?"
 * Beds, referrals both ways, ambulances, who is on duty, and open alerts.
 */
@Injectable()
export class OverviewService {
  constructor(
    @InjectModel(Facility.name) private readonly facilities: Model<FacilityDocument>,
    @InjectModel(BedCategory.name) private readonly beds: Model<BedCategoryDocument>,
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    @InjectModel(Offer.name) private readonly offers: Model<OfferDocument>,
    @InjectModel(Ambulance.name) private readonly ambulances: Model<AmbulanceDocument>,
    @InjectModel(AmbulanceRequest.name) private readonly requests: Model<AmbulanceRequestDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(DutyRoster.name) private readonly rosters: Model<DutyRosterDocument>,
    @InjectModel(Alert.name) private readonly alerts: Model<AlertDocument>,
  ) {}

  async forFacility(facilityCode: string) {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [facility, beds, offersOpen, pendingApproval, inbound, outgoing, sent24h, received24h, fleet, jobs, staff, roster, alerts] =
      await Promise.all([
        this.facilities
          .findOne({ facilityCode }, { name: 1, displayCode: 1, level: 1, settings: 1, plan: 1, fleet: 1, contacts: 1, status: 1 })
          .lean(),
        this.beds.find({ facilityCode }).lean(),
        this.offers.countDocuments({ targetFacility: facilityCode, status: 'offered' }),
        this.offers.countDocuments({ targetFacility: facilityCode, status: 'pending_approval' }),
        this.cases
          .find({ acceptedBy: facilityCode, stage: { $in: INBOUND } }, { caseNumber: 1, stage: 1, brief: 1, senderFacility: 1, transport: 1, bedHold: 1, updatedAt: 1 })
          .sort({ updatedAt: -1 })
          .limit(20)
          .lean(),
        this.cases.countDocuments({ senderFacility: facilityCode, stage: { $in: OPEN_OUTGOING } }),
        this.cases.countDocuments({ senderFacility: facilityCode, createdAt: { $gte: dayAgo } }),
        this.cases.countDocuments({ acceptedBy: facilityCode, updatedAt: { $gte: dayAgo } }),
        this.ambulances.find({ ownerFacility: facilityCode }, { status: 1 }).lean(),
        this.requests.countDocuments({ providerFacility: facilityCode, status: 'accepted' }),
        this.users.countDocuments({ facilityCode, status: 'active' }),
        this.rosters.findOne({ facilityCode, weekStart: lagosWeekStart(now) }).lean(),
        this.alerts
          .find({ audience: 'facility', facilityCode, status: { $ne: 'resolved' } })
          .sort({ createdAt: -1 })
          .limit(10)
          .lean(),
      ]);

    const onDutyIds = new Set(
      (roster?.entries ?? []).filter((e) => e.onDutyFrom <= now && now < e.onDutyTo).map((e) => String(e.userId)),
    );
    const bedRows = beds.map((b) => {
      const s = bedStatus(b.maxSpaces, b.limitedThreshold, b.occupied);
      return {
        name: b.name,
        maxSpaces: b.maxSpaces,
        occupied: b.occupied,
        free: s.free,
        limitedThreshold: b.limitedThreshold,
        status: s.status,
        freshness: freshness(b.updatedAt, now),
        updatedAt: b.updatedAt,
      };
    });
    const count = (s: string) => fleet.filter((a) => a.status === s).length;

    return {
      facility,
      generatedAt: now,
      beds: {
        categories: bedRows,
        totalMax: bedRows.reduce((n, b) => n + b.maxSpaces, 0),
        totalFree: bedRows.reduce((n, b) => n + b.free, 0),
        staleCategories: bedRows.filter((b) => b.freshness === 'stale').length,
      },
      referrals: {
        incomingOpen: offersOpen,
        awaitingMatron: pendingApproval,
        inbound,
        outgoingOpen: outgoing,
        sentLast24h: sent24h,
        receivedLast24h: received24h,
      },
      ambulances: {
        max: facility?.fleet?.maxAmbulances ?? 0,
        registered: fleet.length,
        available: count('available'),
        busy: count('busy'),
        offline: count('offline'),
        activeJobs: jobs,
      },
      staff: { active: staff, onDutyNow: onDutyIds.size, rosterSet: !!roster },
      alerts,
    };
  }
}

@Controller('facilities/me/overview')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.overview.forFacility(user.facilityCode);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Facility.name, schema: FacilitySchema },
      { name: BedCategory.name, schema: BedCategorySchema },
      { name: Case.name, schema: CaseSchema },
      { name: Offer.name, schema: OfferSchema },
      { name: Ambulance.name, schema: AmbulanceSchema },
      { name: AmbulanceRequest.name, schema: AmbulanceRequestSchema },
      { name: User.name, schema: UserSchema },
      { name: DutyRoster.name, schema: DutyRosterSchema },
      { name: Alert.name, schema: AlertSchema },
    ]),
  ],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
