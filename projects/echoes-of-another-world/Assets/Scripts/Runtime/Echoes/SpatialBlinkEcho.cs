using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Echoes
{
    [CreateAssetMenu(menuName = "异界残响/残响/空间闪现")]
    public sealed class SpatialBlinkEcho : EchoMark
    {
        public override bool Activate(EchoContext context)
        {
            const float distance = 4f;
            int obstacleMask = LayerMask.GetMask("Obstacles");
            RaycastHit2D hit = Physics2D.Raycast(
                context.User.position,
                context.Direction,
                distance,
                obstacleMask);
            float actualDistance = hit.collider == null
                ? distance
                : Mathf.Max(0f, hit.distance - 0.6f);
            Vector2 destination = (Vector2)context.User.position + context.Direction * actualDistance;
            Rigidbody2D body = context.User.GetComponent<Rigidbody2D>();
            if (body != null)
            {
                body.position = destination;
                body.velocity = Vector2.zero;
            }
            else
            {
                context.User.position = destination;
            }

            return actualDistance > 0.1f;
        }
    }
}
