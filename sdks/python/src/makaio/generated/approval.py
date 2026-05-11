"""Approval namespace subjects — generated from makaio-bus-protocol.json."""

from __future__ import annotations

from makaio.types import RequestSubject
from makaio.generated.payloads.approval import (
    ApprovalRequestRequest,
    ApprovalRequestResponse,
    ApprovalResolveEnrichedPolicyRequest,
    ApprovalResolveEnrichedPolicyResponse,
)

request: RequestSubject[ApprovalRequestRequest, ApprovalRequestResponse] = RequestSubject("approval.request", request_type=ApprovalRequestRequest, response_type=ApprovalRequestResponse)
resolve_enriched_policy: RequestSubject[ApprovalResolveEnrichedPolicyRequest, ApprovalResolveEnrichedPolicyResponse] = RequestSubject("approval.resolveEnrichedPolicy", request_type=ApprovalResolveEnrichedPolicyRequest, response_type=ApprovalResolveEnrichedPolicyResponse)
