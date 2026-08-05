const TTL = {
  SETTINGS:         60 * 60 * 24,  // 24 hours  — rarely changes
  QUEUE:            15,             // 15 seconds — changes constantly
  STATS_RECEPTION:  30,             // 30 seconds — near real-time
  STATS_ADMIN:      30,             // 30 seconds
  PATIENT_LIST:     60 * 2,        // 2 minutes
  PATIENT_DETAIL:   60 * 5,        // 5 minutes
  LAB_REQUESTS:     15,            // 15 seconds — lab tech updates frequently
  DRUG_STOCK:       60 * 5,        // 5 minutes  — changes on dispense
  LAB_STOCK:        60 * 5,        // 5 minutes  — changes on use
  CHARGE_TEMPLATES: 60 * 60,       // 1 hour     — almost never changes
  STAFF_LIST:       60 * 10,       // 10 minutes
  REPORTS:          60 * 10,       // 10 minutes — expensive queries
}

module.exports = TTL