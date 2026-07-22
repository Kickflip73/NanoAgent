using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.World
{
    public sealed class CameraFollow : MonoBehaviour
    {
        private Transform target;

        public void Configure(Transform followTarget)
        {
            target = followTarget;
            SnapToTarget();
        }

        private void LateUpdate()
        {
            SnapToTarget();
        }

        private void SnapToTarget()
        {
            if (target != null)
            {
                transform.position = new Vector3(target.position.x, target.position.y, -10f);
            }
        }
    }
}
