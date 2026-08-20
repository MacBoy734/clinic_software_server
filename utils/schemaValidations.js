// lib/schemas.js
const { z } = require('zod')

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════════

const IdParam = z.coerce.number().int().positive('ID must be a positive integer')
const Money = z.coerce.number().int().min(0, 'Amount cannot be negative').max(999999, 'Amount too high')
const PositiveMoney = Money.refine((n) => n > 0, 'Amount must be greater than 0')
const Percentage = z.coerce.number().int().min(0).max(500, 'Cannot exceed 500%')
const Quantity = z.coerce.number().int().min(0, 'Quantity cannot be negative').max(100000)
const PositiveQuantity = z.coerce.number().int().positive('Quantity must be at least 1')
const DateField = z.coerce.date()
const FutureDate = z.coerce.date().refine((d) => d > new Date(), { message: 'Date must be in the future' })
const ShortString = z.string().trim().min(1).max(200)
const MediumString = z.string().trim().max(500)
const LongString = z.string().trim().max(2000)
const NullableString = z.string().trim().max(200).nullable().optional()
const Phone = z.string().trim().regex(/^0[17]\d{8}$/, 'Phone must be 10 digits starting with 07 or 01').nullable().optional()
const Email = z.string().trim().email('Invalid email').nullable().optional()
const Address = z.string().trim().max(500).nullable().optional()

// ═══════════════════════════════════════════════════════════════════════════════
// ENUMS — aligned 1:1 with Prisma schema
// ═══════════════════════════════════════════════════════════════════════════════

const RoleEnum = z.enum(['admin', 'doctor', 'receptionist', 'lab_tech', 'pharmacist'])
const VisitTypeEnum = z.enum(['consultation', 'injection', 'family_planning', 'direct_lab'])
const VisitStatusEnum = z.enum(['waiting', 'consultation_paid', 'with_doctor', 'lab', 'pharmacy', 'billing', 'done', 'archived'])
// NOTE: 'waiver' removed — it is a FeeStatus, NOT a PaymentMethod in Prisma.
const PaymentMethodEnum = z.enum(['cash', 'mpesa', 'insurance', 'other', 'credit'])
const ChargeCategoryEnum = z.enum(['consultation', 'procedure', 'lab', 'medication', 'family_planning'])
const ProductCategoryEnum = z.enum(['medication', 'consumable', 'general'])
// NOTE: 'declined' removed — it exists ONLY on PrescriptionItemStatus, not PrescriptionStatus.
const PrescriptionStatusEnum = z.enum(['pending', 'issued', 'dispensed', 'returned', 'cancelled'])
const PrescriptionItemStatusEnum = z.enum(['pending', 'issued', 'declined', 'returned', 'restocked', 'cancelled'])
const LabRequestStatusEnum = z.enum(['pending', 'in_progress', 'ready'])
const LabItemStatusEnum = z.enum(['pending', 'in_progress', 'ready'])
const ExpenseDomainEnum = z.enum(['clinic', 'pharmacy'])
// NOTE: 'reception' added to match Prisma OrderDepartment enum.
const OrderDepartmentEnum = z.enum(['doctor', 'lab'])
const OrderStatusEnum = z.enum(['pending', 'fulfilled', 'cancelled'])
const RestockStatusEnum = z.enum(['pending', 'approved', 'rejected'])
const UrgencyEnum = z.enum(['routine', 'urgent', 'stat'])
const GenderEnum = z.enum(['male', 'female', 'other'])
const BloodGroupEnum = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional().nullable()
const AgeUnitEnum = z.enum(['years', 'months', 'weeks', 'days']).default('years')
const MovementReasonEnum = z.enum(['sale', 'dispense', 'issue', 'restock', 'return_to_stock', 'adjustment', 'writeoff'])

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED INPUT SHAPES
// ═══════════════════════════════════════════════════════════════════════════════

const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

const PeriodQuery = z.object({
  period: z.enum(['today', 'this_week', 'this_month', 'this_year', 'all']).default('this_month'),
})

const SearchQuery = z.object({
  search: z.string().trim().optional(),
  q: z.string().trim().optional(),
})

const PaymentLine = z.object({
  method: PaymentMethodEnum,
  amount: PositiveMoney,
  reference: z.string().trim().max(100).nullable().optional(),
})

// ═══════════════════════════════════════════════════════════════════════════════
// URL PARAMS
// ═══════════════════════════════════════════════════════════════════════════════

const idParamSchema = z.object({
  id: IdParam,
})

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH / STAFF
// ═══════════════════════════════════════════════════════════════════════════════

const addStaffSchema = z.object({
  username: ShortString.max(50),
  role: RoleEnum,
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
}).strip()

const resetPasswordSchema = z.object({
  password: z.string().min(6).max(128),
}).strip()

const killSessionSchema = z.object({
  id: IdParam,
}).strip()

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

const clinicSettingsSchema = z.object({
  name: ShortString.max(200).nullable().optional(),
  tagline: ShortString.max(200).nullable().optional(),
  address: Address,
  phone: Phone,
  email: Email,
})

const pharmacySettingsSchema = z.object({
  markup_pct: Percentage,
  low_stock_threshold: Quantity,
  auto_deduct_on_dispense: z.boolean(),
})

const securitySettingsSchema = z.object({
  session_timeout_hours: z.coerce.number().min(0.25).max(168),
  password_min_length: z.coerce.number().int().min(4).max(128),
  password_expiry_days: z.coerce.number().int().min(0),
  force_relogin_on_inactivity: z.boolean(),
})

const patchSettingsSchema = z.object({
  name: clinicSettingsSchema.shape.name,
  tagline: clinicSettingsSchema.shape.tagline,
  address: clinicSettingsSchema.shape.address,
  phone: clinicSettingsSchema.shape.phone,
  email: clinicSettingsSchema.shape.email,
  lab_settings: z.record(z.unknown()).optional(),
  pharmacy_settings: pharmacySettingsSchema.optional(),
  security: securitySettingsSchema.optional(),
}).partial().refine((data) => Object.keys(data).length > 0, { message: 'No valid fields to update' })

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — CHARGE TEMPLATES & LAB CATALOG
// ═══════════════════════════════════════════════════════════════════════════════

const chargeTemplateSchema = z.object({
  name: ShortString,
  category: ChargeCategoryEnum,
  amount: Money,
  is_active: z.boolean().default(true),
})

const updateChargeTemplateSchema = z.object({
  name: ShortString.optional(),
  category: ChargeCategoryEnum.optional(),
  amount: Money.optional(),
  is_active: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' })

const labCatalogUpdateSchema = z.object({
  unit_cost: Money.optional(),
  is_active: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' })

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — EXPENSES (consolidated)
// ═══════════════════════════════════════════════════════════════════════════════

const createExpenseSchema = z.object({
  domain: ExpenseDomainEnum.optional(),
  description: ShortString,
  amount: Money.refine((n) => n > 0, 'Amount must be greater than 0'),
  category: NullableString,
  incurred_at: DateField.optional(),
})

const updateExpenseSchema = z.object({
  description: ShortString.optional(),
  amount: Money.refine((n) => n > 0, 'Amount must be greater than 0').optional(),
  incurred_at: DateField.optional(),
}).refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' })

const expenseIdSchema = z.coerce.number().int().positive('Invalid expense ID')

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — STOCK
// ═══════════════════════════════════════════════════════════════════════════════

const createLabStockSchema = z.object({
  name: ShortString,
  current_stock: Quantity,
  reorder_level: Quantity.default(0),
  expiry_date: FutureDate.nullable().optional(),
  category: NullableString,
  unit: z.string().trim().min(1).max(50).default('units'),
  unit_cost: Money.default(0),
  supplier: NullableString,
  batch_number: NullableString,
})

const updateLabStockSchema = z.object({
  name: ShortString.optional(),
  current_stock: Quantity.optional(),
  reorder_level: Quantity.optional(),
  expiry_date: z.coerce.date().nullable().optional(),
  category: NullableString,
  unit: z.string().trim().min(1).max(50).optional(),
  unit_cost: Money.optional(),
  supplier: NullableString,
  batch_number: NullableString,
}).refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' })

const updateLabStockQuantitySchema = z.object({
  quantity: Quantity.optional(),
  adjustment: z.coerce.number().int().optional(),
}).refine((data) => data.quantity !== undefined || data.adjustment !== undefined, { message: 'Provide quantity or adjustment' })

// NOTE: Product (drug stock) does NOT have unit_cost or expiry_date at the product level.
// Those live on ProductBatch. This schema matches the Prisma Product model exactly.
const createDrugStockSchema = z.object({
  name: ShortString,
  generic_name: NullableString,
  category: ProductCategoryEnum.default('medication'),
  sub_category: NullableString,
  form: NullableString,
  strength: NullableString,
  current_stock: Quantity,
  unit: z.string().trim().min(1).max(50).default('pieces'),
  reorder_level: Quantity.default(0),
  normal_price: Money.default(0),
  promotional_price: Money.default(0),
  wholesale_price: Money.default(0),
  supplier: NullableString,
})

const updateDrugStockSchema = z.object({
  name: ShortString.optional(),
  reorder_level: Quantity.optional(),
  normal_price: Money.optional(),
  promotional_price: Money.optional(),
  wholesale_price: Money.optional(),
  supplier: NullableString,
}).refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' })

const updateDrugStockQuantitySchema = z.object({
  quantity: Quantity.optional(),
  adjustment: z.coerce.number().int().optional(),
}).refine((data) => data.quantity !== undefined || data.adjustment !== undefined, { message: 'Provide quantity or adjustment' })

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — REFERRALS & RESTOCK
// ═══════════════════════════════════════════════════════════════════════════════

const createReferralSchema = z.object({
  visit_id: IdParam,
  referrer_name: ShortString,
  referrer_facility: NullableString,
  referrer_phone: Phone,
  test_ordered: ShortString,
  test_cost: Money.refine((n) => n > 0, 'Test cost must be positive'),
  commission_rate: z.coerce.number().min(0).max(1).default(0.1),
  notes: MediumString.nullable().optional(),
  referred_at: DateField.optional(),
})

const payReferralSchema = z.object({
  amount_paid: Money.refine((n) => n > 0, 'Amount must be positive'),
  notes: MediumString.nullable().optional(),
})

const verifyRestockSchema = z.object({
  verification_notes: MediumString.nullable().optional(),
  adjusted_qty: PositiveQuantity.optional(),
  expiry_date: DateField.nullable().optional(),
})

const rejectRestockSchema = z.object({
  verification_notes: MediumString.nullable().optional(),
})

// ═══════════════════════════════════════════════════════════════════════════════
// PATIENTS & VISITS
// ═══════════════════════════════════════════════════════════════════════════════

const newPatientSchema = z.object({
  name: ShortString,
  gender: GenderEnum,
  age: z.coerce.number().int().min(1).max(110),
  age_unit: AgeUnitEnum,
  phone: Phone,
  national_id: NullableString,
  blood_group: BloodGroupEnum,
  allergies: z.string().trim().max(500).nullable().optional(),
})

const patientSearchSchema = z.object({
  q: z.string().trim().min(2, 'Query must be at least 2 characters'),
}).strip()

const registerVisitSchema = z.object({
  patient_id: IdParam.optional(),
  patient: newPatientSchema.optional(),
  visit_type: VisitTypeEnum,
  referred_by: NullableString,
  referrer_phone: Phone,
  lab_test_ids: z.array(IdParam).default([]),
}).refine((data) => data.patient_id || data.patient, { message: 'Provide patient_id or patient details' })
  .refine((data) => !(data.visit_type === 'direct_lab' && data.lab_test_ids.length === 0), { message: 'Select at least one lab test for direct lab visits' })
  .strip()

const vitalsSchema = z.object({
  temperature: z.coerce.number().nullable().optional(),
  bp_systolic: z.coerce.number().int().nullable().optional(),
  bp_diastolic: z.coerce.number().int().nullable().optional(),
  pulse: z.coerce.number().int().nullable().optional(),
  respiratory_rate: z.coerce.number().int().nullable().optional(),
  weight: z.coerce.number().nullable().optional(),
  height: z.coerce.number().nullable().optional(),
  spo2: z.coerce.number().int().nullable().optional(),
  vitals_notes: NullableString,
})

const patchVisitSchema = z.object({
  status: VisitStatusEnum,
  doctor_id: IdParam.optional(),
  chief_complaint: NullableString,
  subjective: z.string().trim().max(2000).nullable().optional(),
  objective: z.string().trim().max(2000).nullable().optional(),
  assessment: z.string().trim().max(2000).nullable().optional(),
  plan: z.string().trim().max(2000).nullable().optional(),
  diagnosis: z.string().trim().max(200).nullable().optional(),
  diagnosis_code: z.string().trim().max(50).nullable().optional(),
  notes: NullableString,
  has_lab_results: z.boolean().optional(),
  medication_verification: z.boolean().optional(),
  // Frontend alias — controller maps this to medication_verification in Prisma
  from_pharmacy: z.boolean().optional(),
  ...vitalsSchema.shape,
}).partial().refine((data) => Object.keys(data).length > 0, { message: 'No valid fields to update' })

// ═══════════════════════════════════════════════════════════════════════════════
// BILLING & PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════


const collectPaymentSchema = z.object({
  visit_id: IdParam,
  stage: z.coerce.number().int().refine((n) => n === 1 || n === 2, 'Stage must be 1 or 2'),
  payments: z.array(PaymentLine).min(1, 'Provide at least one payment'),
  discount_amount: z.coerce.number().int().min(0).default(0),
  discount_reason: z.string().trim().min(1).nullable().optional(),
}).refine((data) => !(data.discount_amount > 0 && !data.discount_reason), { message: 'A reason is required when applying a discount' })
  .refine((data) => !(data.stage === 1 && data.discount_amount > 0), { message: 'Discounts are only allowed at stage 2' })

const waivePaymentSchema = z.object({
  stage: z.literal(1).or(z.literal(2)),
  reason: z.string().trim().min(3, 'Reason must be at least 3 characters'),
})

const updateBalanceSchema = z.object({
  source: z.enum(['clinic', 'pharmacy']),
  action: z.enum(['settle', 'waive']),
  amount: Money.refine((n) => n > 0).optional(),
  method: PaymentMethodEnum.optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  reason: z.string().trim().min(1).nullable().optional(),
}).refine((data) => !(data.action === 'waive' && !data.reason), { message: 'Reason is required for waiver' })

const paymentLineSchema = z.object({
  method: PaymentMethodEnum,
  amount: z.coerce.number().int().min(1, 'Amount must be at least 1'),
  reference: z.string().trim().max(100).nullable().optional(),
})

const paymentModalSchema = z.object({
  payments: z.array(paymentLineSchema).min(1, 'Add at least one payment'),
  discount_amount: z.coerce.number().int().min(0).default(0),
  discount_reason: z.string().trim().min(1).nullable().optional(),
}).refine(
  (data) => !(data.discount_amount > 0 && !data.discount_reason),
  { message: 'A reason is required when applying a discount', path: ['discount_reason'] }
)

// ═══════════════════════════════════════════════════════════════════════════════
// PHARMACY — PRESCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

const prescriptionItemSchema = z.object({
  medication: z.string().trim().min(1, 'Medication name required').max(200),
  product_id: IdParam,
  drug_id: IdParam,
  dosage: z.string().trim().max(100).default(''),
  frequency: z.string().trim().max(100).default(''),
  duration: z.string().trim().max(100).default(''),
  quantity: PositiveQuantity,
  unit_cost: Money.refine((v) => v >= 1, 'Unit price must be at least 1'),
  form: z.string().trim().max(100).optional(),
})

const createPrescriptionSchema = z.object({
  items: z.array(prescriptionItemSchema).min(1, 'Add at least one medication'),
  notes: NullableString,
})

const returnItemSchema = z.object({
  item_id: IdParam,
  doctor_name: ShortString.optional(),
  reason: z.string().trim().min(1, 'A reason is required'),
})

const rejectItemRestockSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
})

const returnPrescriptionSchema = z.object({
  doctor_name: ShortString.optional(),
  reason: z.string().trim().min(1, 'A reason is required'),
})

const verifyPrescriptionSchema = z.object({
  doctor_name: ShortString.optional(),
  notes: NullableString,
})

// ═══════════════════════════════════════════════════════════════════════════════
// PHARMACY — OTC SALES
// ═══════════════════════════════════════════════════════════════════════════════

const otcSaleItemSchema = z.object({
  product_id: IdParam.optional(),
  drug_id: IdParam.optional(),
  name: z.string().trim().max(200).optional(),
  quantity: PositiveQuantity,
  unit_price: Money.default(0),
  price_tier: z.enum(['normal', 'promotional', 'wholesale']).default('normal'),
}).refine((data) => data.product_id || data.name, { message: 'Custom lines need a name' })

const createOtcSaleSchema = z.object({
  customer_name: z.string().trim().max(200).default('Walk-in Customer'),
  customer_phone: Phone,
  payments: z.array(PaymentLine).min(1),
  items: z.array(otcSaleItemSchema).min(1, 'At least one item required'),
  discount_amount: z.coerce.number().int().min(0).default(0),
  discount_reason: z.string().trim().min(1).nullable().optional(),
}).refine((data) => !(data.discount_amount > 0 && !data.discount_reason), { message: 'A reason is required for every discount' })

// ═══════════════════════════════════════════════════════════════════════════════
// PHARMACY — ORDERS & RESTOCK
// ═══════════════════════════════════════════════════════════════════════════════

const orderItemSchema = z.object({
  product_id: IdParam.optional(),
  name: z.string().trim().max(200).optional(),
  quantity: PositiveQuantity,
  notes: NullableString,
}).refine((data) => data.product_id || data.name, { message: 'Each item needs a product or a name' })

const createInternalOrderSchema = z.object({
  department: OrderDepartmentEnum,
  items: z.array(orderItemSchema).min(1),
  notes: NullableString,
})

const fulfillOrderSchema = z.object({
  lines: z.array(z.object({
    item_id: IdParam,
    quantity: Quantity,
  })).optional(),
})

const cancelOrderSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to cancel an order'),
})

const createRestockRequestSchema = z.object({
  product_id: IdParam.optional(),
  drug_stock_id: IdParam.optional(),
  quantity: PositiveQuantity,
  expiry_date: FutureDate.nullable().optional(),
  notes: NullableString,
}).refine((data) => data.product_id || data.drug_stock_id, { message: 'product_id or drug_stock_id is required' })

const collectCustomerPaymentSchema = z.object({
  customer_id: IdParam,
  amount: Money.refine((n) => n > 0, 'Amount must be positive'),
  method: PaymentMethodEnum,
  reference: z.string().trim().max(100).nullable().optional(),
})

// ═══════════════════════════════════════════════════════════════════════════════
// LAB
// ═══════════════════════════════════════════════════════════════════════════════

const orderLabTestsSchema = z.object({
  test_ids: z.array(IdParam).min(1, 'Select at least one test'),
  urgency: UrgencyEnum.default('routine'),
})

const stockUsageRowSchema = z.object({
  stock_item_id: IdParam,
  item_name: z.string().trim().max(200).optional(),
  quantity: PositiveQuantity,
})

const itemResultSchema = z.object({
  id: IdParam,
  result: z.string().trim().max(5000).nullable().optional(),
  result_data: z.record(z.unknown()).nullable().optional(),
  result_notes: z.string().trim().max(2000).nullable().optional(),
  flagged: z.boolean().default(false),
  stock_used: z.array(stockUsageRowSchema).optional(),
})

const updateLabRequestSchema = z.object({
  status: z.enum(['in_progress', 'ready']),
  item_results: z.array(itemResultSchema).default([]),
})

const completeProcedureSchema = z.object({
  price: PositiveMoney
})

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

const createNotificationSchema = z.object({
  type: ShortString,
  title: ShortString,
  message: MediumString,
  visit_id: IdParam.optional(),
  target_role: z.array(z.string().trim()).optional(),
  target_staff_id: IdParam.optional(),
  staff_id: IdParam.optional(),
})

const deleteOldNotificationsSchema = z.object({
  hours: z.coerce.number().int().min(1).default(48),
})

// ═══════════════════════════════════════════════════════════════════════════════
// DOCTOR-SPECIFIC QUERY & PARAM SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const patientDatabaseQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  gender: GenderEnum.optional(),
  age_group: z.enum(['under5', 'over5', 'under18', 'adult', 'senior']).optional(),
  visit_type: VisitTypeEnum.optional(),
  diagnosis_code: z.string().trim().optional(),
  has_allergies: z.enum(['0', '1']).optional(),
  date_from: z.string().trim().optional(),
  date_to: z.string().trim().optional(),
})

// SUPPLIES

const suppliesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
})


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Primitives
  IdParam, Money, PositiveMoney, Percentage, Quantity, PositiveQuantity,
  DateField, FutureDate, ShortString, MediumString, LongString, NullableString,
  Phone, Email, Address, PaginationQuery, PeriodQuery, SearchQuery, PaymentLine,

  // Enums
  RoleEnum, VisitTypeEnum, VisitStatusEnum, PaymentMethodEnum, ChargeCategoryEnum,
  ProductCategoryEnum, PrescriptionStatusEnum, PrescriptionItemStatusEnum,
  LabRequestStatusEnum, LabItemStatusEnum, ExpenseDomainEnum, OrderDepartmentEnum,
  OrderStatusEnum, RestockStatusEnum, UrgencyEnum, GenderEnum, BloodGroupEnum,
  AgeUnitEnum, MovementReasonEnum,

  // URL / Query
  idParamSchema, patientDatabaseQuerySchema, suppliesQuerySchema,

  // Auth
  addStaffSchema, resetPasswordSchema, killSessionSchema,

  // Admin
  clinicSettingsSchema, pharmacySettingsSchema, securitySettingsSchema, patchSettingsSchema,
  chargeTemplateSchema, updateChargeTemplateSchema, labCatalogUpdateSchema,
  createExpenseSchema, updateExpenseSchema, expenseIdSchema,
  createLabStockSchema, updateLabStockSchema, updateLabStockQuantitySchema,
  createDrugStockSchema, updateDrugStockSchema, updateDrugStockQuantitySchema,
  createReferralSchema, payReferralSchema, verifyRestockSchema, rejectRestockSchema,

  // Patients
  newPatientSchema, patientSearchSchema, registerVisitSchema, vitalsSchema, patchVisitSchema,

  // Billing
 collectPaymentSchema, waivePaymentSchema, updateBalanceSchema,

  // Pharmacy
  prescriptionItemSchema,rejectItemRestockSchema,  createPrescriptionSchema, returnItemSchema, returnPrescriptionSchema,
  verifyPrescriptionSchema, otcSaleItemSchema, createOtcSaleSchema,
  orderItemSchema, createInternalOrderSchema, fulfillOrderSchema, cancelOrderSchema,
  createRestockRequestSchema, collectCustomerPaymentSchema,

  // Lab
  orderLabTestsSchema, stockUsageRowSchema, itemResultSchema, updateLabRequestSchema, completeProcedureSchema,

  // Notifications
  createNotificationSchema, deleteOldNotificationsSchema,
}