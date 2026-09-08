
// Namespace for the production application workloads.
// Everything the pipeline deploys and everything RBAC scopes below
// lives in here, not in "default" — see the namespace flag sent to Caleb/David.
resource "kubernetes_namespace_v1" "alerts_prod" {
  metadata {
    name = "alerts-prod"
  }
}

// Least-privilege Role for the CI/CD pipeline identity.
// Scoped to alerts-prod only — this is NOT cluster-admin, unlike the
// Caleb/Aundrea system:masters grants in the aws-auth ConfigMap above.
resource "kubernetes_role_v1" "pipeline_deployer" {
  metadata {
    name      = "pipeline-deployer"
    namespace = kubernetes_namespace_v1.alerts_prod.metadata[0].name
  }

  // Core resources a Helm release typically manages: pods, services,
  // configmaps, secrets, service accounts, and any PVCs.
  rule {
    api_groups = [""]
    resources  = ["pods", "services", "configmaps", "secrets", "serviceaccounts", "persistentvolumeclaims"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  // Deployments/ReplicaSets — the actual workload rollout objects.
  rule {
    api_groups = ["apps"]
    resources  = ["deployments", "replicasets"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  // Ingress, for whatever the Helm chart exposes externally.
  rule {
    api_groups = ["networking.k8s.io"]
    resources  = ["ingresses"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  // HPA, in case the chart defines autoscaling on top of KEDA.
  rule {
    api_groups = ["autoscaling"]
    resources  = ["horizontalpodautoscalers"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }
}

// Binds the Role above to a group name, not a specific user —
// the aws-auth entry for the CI role (added separately, once Caleb
// provides the exact role ARN) maps into this same group.
resource "kubernetes_role_binding_v1" "pipeline_deployer" {
  metadata {
    name      = "pipeline-deployer-binding"
    namespace = kubernetes_namespace_v1.alerts_prod.metadata[0].name
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.pipeline_deployer.metadata[0].name
  }

  subject {
    kind      = "Group"
    name      = "pipeline-deployers"
    api_group = "rbac.authorization.k8s.io"
  }
}
