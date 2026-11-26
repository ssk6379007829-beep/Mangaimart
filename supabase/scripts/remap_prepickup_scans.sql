-- One-off data fix (run by hand), 2026-11-26.
--
-- Background: Shiprocket's mapStage() (and Shadowfax's) used to have no
-- `pickup_pending` branch, so a pre-pickup courier scan — "OUT FOR PICKUP",
-- "PICKUP SCHEDULED", a Shadowfax "new"/"ARRIVED" — was recorded as `in_transit`.
-- That mislabel showed the buyer "In Transit — On its way to your city" and lit
-- the seller's stepper up to "In transit" while the courier had not yet
-- collected the parcel. The mappers are fixed going forward; this corrects the
-- rows already stored.
--
-- Safe: `pickup_pending` is inert in apply_shipment_scan() exactly like
-- `in_transit` was — neither moves an order nor releases a payout. This only
-- changes the stage a timeline reads. It is also idempotent.
--
-- Scope guard: only rows whose RAW status actually reads as a pre-pickup event
-- are touched, and `last_status` is recomputed ONLY for the shipments whose
-- events this statement changed — nothing else is disturbed.

with remapped as (
  update shipment_events
     set stage = 'pickup_pending'
   where stage = 'in_transit'
     and raw_status ~* 'pickup|manifest|awaiting|^new$'
     -- …but never a collection event, which is a real movement.
     and raw_status !~* 'picked|pickup complete|pickup done'
  returning shipment_id
),
latest as (
  select distinct on (e.shipment_id)
         e.shipment_id, e.stage, e.occurred_at
    from shipment_events e
   where e.shipment_id in (select shipment_id from remapped)
   order by e.shipment_id,
            e.occurred_at desc nulls last,
            e.created_at desc
)
update shipments s
   set last_status    = l.stage,
       last_status_at = coalesce(l.occurred_at, s.last_status_at)
  from latest l
 where l.shipment_id = s.id
   and s.last_status is distinct from l.stage;
